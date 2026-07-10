# Solarisael House — OMP adapter

This repository connects [Solarisael House](https://github.com/solarisael/solarisael-house) to [Oh My Pi](https://github.com/can1357/oh-my-pi).

The human-facing introduction, installation protocol, and identity-writing guide live in the canonical House repository:

- [Solarisael House README](https://github.com/solarisael/solarisael-house#readme)
- [AI-guided OMP installation](https://github.com/solarisael/solarisael-house/blob/main/INSTALL.md)
- [Room identity guide](https://github.com/solarisael/solarisael-house/blob/main/IDENTITY_GUIDE.md)

## Build the portable bundle

Keep this repository and `solarisael-house` as sibling directories, then run:

```text
bun install
bun run build:portable
```

The private-data-free archive is written to:

```text
dist/solarisael-house-portable.zip
```

The archive contains the canonical public README and guides, the core and OMP adapter as sibling runtime trees, a fictional starter room, and a deterministic installation verifier.

## Test

```text
bun test
```

Licensed under Apache-2.0. Original project and design by Sol; see `NOTICE`.
