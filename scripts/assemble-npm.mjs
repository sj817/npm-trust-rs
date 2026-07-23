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
//   --publish          Run `npm publish --access public` for each sub-package + main.
//
// Publishing uses whatever npm auth is in the environment (NPM_TOKEN / .npmrc), or npm's
// OIDC Trusted Publishing when run from a configured CI workflow.

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const MAIN_PKG_DIR = join(ROOT, "npm", "npt");
const DIST_DIR = join(ROOT, "npm", "dist");

const SCOPE = "@qwqojs";
const BIN_UNIX = "npt";
const BIN_WIN = "npt.exe";

// One entry per supported platform.
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

function pkgName(t) {
  return `${SCOPE}/npt-${t.platform}-${t.arch}`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const mainPkg = JSON.parse(readFileSync(join(MAIN_PKG_DIR, "package.json"), "utf8"));
  const version = args.version ?? mainPkg.version;

  if (!args.artifacts) throw new Error("--artifacts <dir> is required");
  const artifactsDir = args.artifacts;

  rmSync(DIST_DIR, { recursive: true, force: true });
  mkdirSync(DIST_DIR, { recursive: true });

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

  // Keep the main package's version + optionalDependencies pins in sync.
  mainPkg.version = version;
  mainPkg.optionalDependencies = Object.fromEntries(
    TARGETS.map((t) => [pkgName(t), version])
  );
  writeFileSync(join(MAIN_PKG_DIR, "package.json"), JSON.stringify(mainPkg, null, 2) + "\n");
  console.log(`✓ synced main package @qwqojs/npt@${version}`);

  if (args.publish) {
    for (const b of built) {
      console.log(`→ publishing ${b.name}…`);
      execFileSync("npm", ["publish", "--access", "public"], { cwd: b.dir, stdio: "inherit" });
    }
    // Main package last, so its optional deps already exist.
    console.log("→ publishing @qwqojs/npt…");
    execFileSync("npm", ["publish", "--access", "public"], { cwd: MAIN_PKG_DIR, stdio: "inherit" });
  } else {
    console.log(`\nAssembled ${built.length} platform package(s) under npm/dist/.`);
    console.log("Re-run with --publish to publish them + the main package.");
  }
}

main();
