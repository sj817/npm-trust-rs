#!/usr/bin/env node
// Assemble the platform-specific npm sub-packages for `@qwqojs/npt`.
//
// For each target it creates `npm/dist/<pkg>/` containing a package.json (with the
// right `os`/`cpu`) and the compiled binary, keeping versions in sync with the main
// package. Optionally publishes every sub-package and then the main package.
//
// Usage:
//   node scripts/assemble-npm.mjs --artifacts <dir> [--version <v>] [--publish]
//
//   --artifacts <dir>  Directory with one subdir per Rust target triple, each holding
//                      the built binary (npt or npt.exe). Layout:
//                        <dir>/<rust-target>/npt[.exe]
//   --version  <v>     Version to stamp (default: version in npm/npt/package.json).
//   --publish          Publish every sub-package + the main package.
//
// Publishing auth:
//   • Interactive terminal (local first-publish): you are prompted ONCE for your npm
//     OTP (2FA); every `npm publish` reuses it via `--otp`, exploiting npm's ~5-minute
//     window. If the window expires mid-run, it re-prompts and continues.
//   • Non-interactive (CI): no prompt — relies on npm OIDC Trusted Publishing
//     (id-token) or an ambient token.

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import * as readline from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const MAIN_PKG_DIR = join(ROOT, "npm", "npt");
const DIST_DIR = join(ROOT, "npm", "dist");

const SCOPE = "@qwqojs";
const BIN_UNIX = "npt";
const BIN_WIN = "npt.exe";

// npm on Windows is npm.cmd; run it through the shell so it resolves.
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const NPM_SHELL = process.platform === "win32";

const TARGETS = [
  { platform: "win32", arch: "x64", rustTarget: "x86_64-pc-windows-msvc", bin: BIN_WIN },
  { platform: "win32", arch: "arm64", rustTarget: "aarch64-pc-windows-msvc", bin: BIN_WIN },
  { platform: "darwin", arch: "x64", rustTarget: "x86_64-apple-darwin", bin: BIN_UNIX },
  { platform: "darwin", arch: "arm64", rustTarget: "aarch64-apple-darwin", bin: BIN_UNIX },
  { platform: "linux", arch: "x64", rustTarget: "x86_64-unknown-linux-gnu", bin: BIN_UNIX },
  { platform: "linux", arch: "arm64", rustTarget: "aarch64-unknown-linux-gnu", bin: BIN_UNIX },
];

function parseArgs(argv) {
  const args = { artifacts: null, version: null, publish: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--artifacts") args.artifacts = argv[++i];
    else if (a === "--version") args.version = argv[++i];
    else if (a === "--publish") args.publish = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

const pkgName = (t) => `${SCOPE}/npt-${t.platform}-${t.arch}`;

function assemble(version, artifactsDir) {
  rmSync(DIST_DIR, { recursive: true, force: true });
  mkdirSync(DIST_DIR, { recursive: true });

  const mainPkg = JSON.parse(readFileSync(join(MAIN_PKG_DIR, "package.json"), "utf8"));
  const built = [];
  for (const t of TARGETS) {
    const name = pkgName(t);
    const srcBin = join(artifactsDir, t.rustTarget, t.bin);
    if (!existsSync(srcBin)) {
      console.warn(`! skipping ${name}: binary not found at ${srcBin}`);
      continue;
    }
    const outDir = join(DIST_DIR, `npt-${t.platform}-${t.arch}`);
    mkdirSync(outDir, { recursive: true });
    const subPkg = {
      name,
      version,
      description: `npt binary for ${t.platform} ${t.arch}`,
      repository: mainPkg.repository,
      license: mainPkg.license,
      os: [t.platform],
      cpu: [t.arch],
      files: [t.bin],
    };
    writeFileSync(join(outDir, "package.json"), JSON.stringify(subPkg, null, 2) + "\n");
    copyFileSync(srcBin, join(outDir, t.bin));
    built.push({ name, dir: outDir });
    console.log(`✓ assembled ${name}@${version}`);
  }

  // Sync the main package version + optionalDependencies pins.
  mainPkg.version = version;
  mainPkg.optionalDependencies = Object.fromEntries(TARGETS.map((t) => [pkgName(t), version]));
  writeFileSync(join(MAIN_PKG_DIR, "package.json"), JSON.stringify(mainPkg, null, 2) + "\n");
  console.log(`✓ synced main package ${mainPkg.name}@${version}`);

  return { mainPkg, built };
}

function publishOnce(dir, otp) {
  const args = ["publish", "--access", "public"];
  if (otp) args.push(`--otp=${otp}`);
  execFileSync(NPM, args, { cwd: dir, stdio: "inherit", shell: NPM_SHELL });
}

async function promptOtp(rl, message, allowEmpty = false) {
  for (;;) {
    const ans = (await rl.question(message)).trim();
    if (allowEmpty && ans === "") return "";
    if (/^\d{6,8}$/.test(ans)) return ans;
    console.error("  OTP must be 6–8 digits.");
  }
}

async function publishAll(mainPkg, built) {
  const targets = [...built, { name: mainPkg.name, dir: MAIN_PKG_DIR }]; // main last
  const interactive = process.stdin.isTTY && process.stdout.isTTY;

  let rl = null;
  let otp = "";
  if (interactive) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    otp = await promptOtp(
      rl,
      `Enter your npm OTP (2FA) to publish ${targets.length} package(s): `
    );
  }

  try {
    for (const p of targets) {
      let published = false;
      while (!published) {
        try {
          console.log(`→ publishing ${p.name}…`);
          publishOnce(p.dir, otp);
          console.log(`✓ published ${p.name}`);
          published = true;
        } catch (err) {
          if (!interactive) throw err; // CI: no retry loop
          // Most likely the OTP window expired; re-prompt and retry this package.
          otp = await promptOtp(
            rl,
            `  publish failed (OTP may have expired). Re-enter OTP (blank to skip ${p.name}): `,
            true
          );
          if (otp === "") {
            console.warn(`! skipped ${p.name}`);
            break;
          }
        }
      }
      // Space out writes a little (npm-friendly).
      await sleep(500);
    }
  } finally {
    if (rl) rl.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.artifacts) throw new Error("--artifacts <dir> is required");
  const mainPkgJson = JSON.parse(readFileSync(join(MAIN_PKG_DIR, "package.json"), "utf8"));
  const version = args.version ?? mainPkgJson.version;

  const { mainPkg, built } = assemble(version, args.artifacts);

  if (!args.publish) {
    console.log(`\nAssembled ${built.length} platform package(s) under npm/dist/.`);
    console.log("Re-run with --publish to publish them + the main package.");
    return;
  }
  if (built.length === 0) {
    throw new Error("nothing to publish — no platform binaries were found in --artifacts");
  }
  await publishAll(mainPkg, built);
  console.log("\n✓ all packages published.");
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
