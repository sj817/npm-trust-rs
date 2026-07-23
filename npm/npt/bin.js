#!/usr/bin/env node
"use strict";

// Launcher for the `npt` native binary. The real executable ships in a
// platform-specific optional dependency (see optionalDependencies in
// package.json); npm installs only the one matching the host os/cpu. We resolve
// it here and exec it, forwarding argv/stdio/exit code.

const { spawnSync } = require("node:child_process");

// "platform arch" -> { pkg, bin }
const BINARIES = {
  "win32 x64": { pkg: "@qwqojs/npt-win32-x64", bin: "npt.exe" },
  "win32 arm64": { pkg: "@qwqojs/npt-win32-arm64", bin: "npt.exe" },
  "darwin x64": { pkg: "@qwqojs/npt-darwin-x64", bin: "npt" },
  "darwin arm64": { pkg: "@qwqojs/npt-darwin-arm64", bin: "npt" },
  "linux x64": { pkg: "@qwqojs/npt-linux-x64", bin: "npt" },
  "linux arm64": { pkg: "@qwqojs/npt-linux-arm64", bin: "npt" },
};

function resolveBinary() {
  const key = `${process.platform} ${process.arch}`;
  const target = BINARIES[key];
  if (!target) {
    console.error(`npt: unsupported platform "${key}".`);
    console.error(`Supported: ${Object.keys(BINARIES).join(", ")}`);
    console.error("Build from source instead: https://github.com/sj817/npm-trust-rs");
    process.exit(1);
  }
  try {
    // Resolves to the binary file inside the installed optional dependency.
    return require.resolve(`${target.pkg}/${target.bin}`);
  } catch {
    console.error(
      `npt: the platform binary for "${key}" (${target.pkg}) is not installed.\n` +
        "This usually means optional dependencies were skipped. Reinstall without\n" +
        "disabling them, e.g.:  npm install -g @qwqojs/npt"
    );
    process.exit(1);
  }
}

const binPath = resolveBinary();
const result = spawnSync(binPath, process.argv.slice(2), { stdio: "inherit" });

if (result.error) {
  console.error(`npt: failed to launch binary: ${result.error.message}`);
  process.exit(1);
}
// Propagate signal-kills as conventional 128+signal exit codes.
if (result.signal) {
  process.exit(1);
}
process.exit(result.status ?? 0);
