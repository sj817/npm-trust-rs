//! A tiny loopback HTTP server for wire-contract tests — the TS analogue of the
//! Rust suite's wiremock. Tests program a `Responder` and inspect `requests`.

import { createServer } from 'node:http'

import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface CapturedRequest {
  body: string
  headers: Record<string, string | undefined>
  method: string
  path: string
}

export type Responder = (
  req: CapturedRequest,
  callIndex: number,
) => { body?: string; headers?: Record<string, string>; status: number }

export class MockRegistry {
  private responder: Responder = () => ({ status: 200, body: '{}' })
  private server?: Server
  readonly requests: CapturedRequest[] = []
  url = ''

  respondWith(responder: Responder): void {
    this.responder = responder
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', c => {
        chunks.push(c as Buffer)
      })
      req.on('end', () => {
        const headers: Record<string, string | undefined> = {}
        for (const [k, v] of Object.entries(req.headers)) {
          headers[k] = Array.isArray(v) ? v.join(', ') : v
        }
        const captured: CapturedRequest = {
          method: req.method ?? '',
          path: req.url ?? '',
          headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }
        const idx = this.requests.length
        this.requests.push(captured)
        const r = this.responder(captured, idx)
        res.writeHead(r.status, r.headers ?? { 'content-type': 'application/json' })
        res.end(r.body ?? '')
      })
    })
    this.server = server
    await new Promise<void>(resolve => {
      server.listen(0, '127.0.0.1', resolve)
    })
    const addr = server.address() as AddressInfo
    this.url = `http://127.0.0.1:${addr.port}/`
  }

  async stop(): Promise<void> {
    const server = this.server
    if (!server) return
    await new Promise<void>((resolve, reject) => {
      server.close(e => (e ? reject(e) : resolve()))
    })
  }
}
