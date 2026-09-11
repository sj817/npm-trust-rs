//! Wire-contract tests — the TS port of `crates/npm-trust/tests/protocol.rs`.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { MockRegistry } from './helpers/mockRegistry'
import {
  Client,
  ConflictError,
  ForbiddenError,
  githubTrust,
  IpBlockedError,
  NotFoundError,
  OtpRequiredError,
  Permission,
  RegistryError,
} from '../src/registry/index'

const ctx: { mock: MockRegistry } = { mock: new MockRegistry() }

beforeEach(async () => {
  ctx.mock = new MockRegistry()
  await ctx.mock.start()
})

afterEach(async () => {
  await ctx.mock.stop()
})

function client(): Client {
  return new Client({ baseUrl: ctx.mock.url, token: 'test-token', maxRetries: 2 })
}

const json = (status: number, body: unknown, headers?: Record<string, string>) => ({
  status,
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
})

describe('protocol', () => {
  it('whoami sends Bearer auth and parses username', async () => {
    ctx.mock.respondWith(req => {
      expect(req.method).toBe('GET')
      expect(req.path).toBe('/-/whoami')
      expect(req.headers['authorization']).toBe('Bearer test-token')
      return json(200, { username: 'alice' })
    })
    const who = await client().whoami()
    expect(who.username).toBe('alice')
  })

  it('package_exists maps 200 → true and 404 → false', async () => {
    ctx.mock.respondWith(req =>
      req.path === '/missing-pkg'
        ? json(404, { error: 'Not found' })
        : json(200, { name: 'exists-pkg' }),
    )
    const c = client()
    expect(await c.packageExists('exists-pkg')).toBe(true)
    expect(await c.packageExists('missing-pkg')).toBe(false)
  })

  it('latest_manifest reads GET /<esc>/latest and maps 404 → undefined', async () => {
    ctx.mock.respondWith(req => {
      expect(req.method).toBe('GET')
      if (req.path === '/@acme%2fmissing/latest') return json(404, 'Not Found')
      expect(req.path).toBe('/@acme%2fwidget/latest')
      return json(200, {
        name: '@acme/widget',
        version: '1.2.3',
        optionalDependencies: { '@acme/widget-linux-x64': '1.2.3' },
        repository: { type: 'git', url: 'git+https://github.com/acme/widget.git' },
      })
    })
    const c = client()
    const manifest = await c.latestManifest('@acme/widget')
    expect(manifest?.version).toBe('1.2.3')
    expect(Object.keys(manifest?.optionalDependencies ?? {})).toEqual(['@acme/widget-linux-x64'])
    expect(await c.latestManifest('@acme/missing')).toBeUndefined()
  })

  it('list_trust escapes scoped name and normalizes a single object', async () => {
    ctx.mock.respondWith(req => {
      expect(req.path).toBe('/-/package/@acme%2fwidget/trust')
      return json(200, {
        id: 'cfg_1',
        type: 'github',
        claims: { repository: 'acme/widget', workflow_ref: { file: 'publish.yml' } },
        permissions: ['createPackage'],
      })
    })
    const configs = await client().listTrust('@acme/widget')
    expect(configs).toHaveLength(1)
    expect(configs[0]?.id).toBe('cfg_1')
    expect(configs[0]?.permissions).toEqual([Permission.Publish])
  })

  it('create_trust posts a one-element array body and omits id', async () => {
    ctx.mock.respondWith(req => {
      expect(req.method).toBe('POST')
      expect(req.path).toBe('/-/package/widget/trust')
      expect(req.headers['authorization']).toBe('Bearer test-token')
      const parsed = JSON.parse(req.body) as unknown[]
      expect(Array.isArray(parsed)).toBe(true)
      expect(parsed).toHaveLength(1)
      expect(parsed[0]).toEqual({
        type: 'github',
        claims: { repository: 'acme/widget', workflow_ref: { file: 'publish.yml' } },
        permissions: ['createPackage'],
      })
      expect(parsed[0]).not.toHaveProperty('id')
      return json(200, {
        id: 'cfg_new',
        type: 'github',
        claims: { repository: 'acme/widget', workflow_ref: { file: 'publish.yml' } },
        permissions: ['createPackage'],
      })
    })
    const cfg = githubTrust('acme/widget', 'publish.yml', undefined, [Permission.Publish])
    const created = await client().createTrust('widget', cfg)
    expect(created[0]?.id).toBe('cfg_new')
  })

  it('revoke_trust url-encodes the id', async () => {
    ctx.mock.respondWith(req => {
      expect(req.method).toBe('DELETE')
      expect(req.path).toBe('/-/package/widget/trust/cfg%2F1')
      return { status: 200, body: '' }
    })
    await client().revokeTrust('widget', 'cfg/1')
    expect(ctx.mock.requests).toHaveLength(1)
  })

  it('surfaces an OTP challenge, and replay with the header succeeds', async () => {
    // Without an OTP header → 401 challenge.
    ctx.mock.respondWith(() =>
      json(
        401,
        { error: 'This operation requires a one-time password' },
        { 'www-authenticate': 'OTP' },
      ),
    )
    const cfg = githubTrust('acme/widget', 'publish.yml', undefined, [Permission.Publish])
    await expect(client().createTrust('widget', cfg)).rejects.toBeInstanceOf(OtpRequiredError)

    // With an OTP → the npm-otp header is sent and the write succeeds.
    ctx.mock.respondWith(req => {
      expect(req.headers['npm-otp']).toBe('123456')
      return json(200, {
        id: 'cfg_ok',
        type: 'github',
        claims: { repository: 'acme/widget', workflow_ref: { file: 'publish.yml' } },
        permissions: ['createPackage'],
      })
    })
    const created = await client().createTrust('widget', cfg, '123456')
    expect(created[0]?.id).toBe('cfg_ok')
  })

  it('detects OTP by the body heuristic without a header', async () => {
    ctx.mock.respondWith(() => ({
      status: 401,
      headers: { 'content-type': 'text/plain' },
      body: 'you need a one-time password to continue',
    }))
    await expect(client().revokeTrust('widget', 'cfg_1')).rejects.toBeInstanceOf(OtpRequiredError)
  })

  it('retries a rate-limited request then succeeds', async () => {
    ctx.mock.respondWith((_req, i) =>
      i === 0 ? { status: 429, headers: { 'retry-after': '0' }, body: '' } : json(200, []),
    )
    const configs = await client().listTrust('widget')
    expect(configs).toEqual([])
    expect(ctx.mock.requests).toHaveLength(2)
  })

  it('maps error codes to typed errors', async () => {
    const cases: Array<[number, unknown]> = [
      [403, ForbiddenError],
      [404, NotFoundError],
      [409, ConflictError],
      [500, RegistryError],
    ]
    for (const [status, type] of cases) {
      ctx.mock.respondWith(() => json(status, { error: `boom ${status}` }))
      await expect(client().listTrust('widget')).rejects.toBeInstanceOf(type as never)
    }
  })

  it('maps www-authenticate: IPAddress to IpBlocked', async () => {
    ctx.mock.respondWith(() => json(401, { error: 'nope' }, { 'www-authenticate': 'IPAddress' }))
    await expect(client().whoami()).rejects.toBeInstanceOf(IpBlockedError)
  })
})
