# @qwqojs/npt

Native Rust CLI for **npm Trusted Publishing (OIDC)** — an interactive setup wizard plus
batch `scan`/`sync`/`audit` tools. Works regardless of your local npm version (even npm
9/10, or no npm at all) for trust operations.

## Install

```sh
npm install -g @qwqojs/npt
npt            # run the wizard in your package directory
```

The real binary ships as a platform-specific optional dependency
(`@qwqojs/npt-<platform>-<arch>`); npm installs only the one matching your OS/CPU. No Rust
toolchain required.

## Usage

Run `npt` inside a package directory to launch the interactive wizard, or use the batch
subcommands. See the [project README](https://github.com/sj817/npm-trust-rs#readme) for
full docs.

## License

MIT OR Apache-2.0
