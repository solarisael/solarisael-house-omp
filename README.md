# Solarisael House — OMP adapter

The recommended [Solarisael House](https://github.com/solarisael/solarisael-house) bridge for [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi).

Start with the canonical House documentation:

- [What Solarisael House is](https://github.com/solarisael/solarisael-house#readme)
- [AI-guided OMP installation](https://github.com/solarisael/solarisael-house/blob/main/INSTALL.md)
- [Room identity guide](https://github.com/solarisael/solarisael-house/blob/main/IDENTITY_GUIDE.md)
- [How to use the House day to day](https://github.com/solarisael/solarisael-house/blob/main/USAGE.md)

## What this adapter adds

- OMP lifecycle hooks for room context and end-of-session continuity
- House tools for room state, memory, recall, lessons, paper boats, and routing
- room-local conversation logging and compact live context
- automatic and agent-initiated recall through the canonical House core
- a hygiene extension for keeping host-generated context out of user-authored continuity
- a private-data-free portable bundle, fictional starter room, and deterministic installation verifier

The adapter fails open: unavailable database or embedding services reduce recall rather than making the Base House unusable.

## Platform expectations

The current guided portable release targets **Windows with OMP and Bun**. The Base House does not require PostgreSQL or a GPU. The optional full substrate currently runs through WSL; see the canonical [installation protocol](https://github.com/solarisael/solarisael-house/blob/main/INSTALL.md).

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

## Test

```text
bun test
```

Licensed under Apache-2.0. Original project and design by Sol; see [`NOTICE`](./NOTICE).
