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
- a long-lived Rust transport for authoritative Full House memory operations
- automatic and agent-initiated recall through the canonical House contracts
- a hygiene extension for keeping host-generated context out of user-authored continuity
- a private-data-free portable bundle, fictional starter room, and deterministic installation verifier
- explicit Base, Full, and configured-but-degraded status for the optional [public substrate](https://github.com/solarisael/solarisael-house-substrate)

The adapter remains TypeScript because it owns OMP lifecycle integration, room discovery, context shaping, packaging, and installation. Rust owns shared contracts and the authoritative Full House process. This is a Rust-first boundary, not a cosmetic rewrite.

The adapter fails open: an absent substrate is valid Base House, while a configured but unhealthy database, embedder, or Rust executable is reported as degraded rather than mistaken for healthy Full House.

## Platform expectations

The current guided portable release targets **Windows with OMP, Bun, and the stable Rust MSVC toolchain**. Base House does not require PostgreSQL or a GPU. Full House adds a release-built Windows Rust substrate process connected to PostgreSQL and the embedding service in WSL. Install it from the canonical [`solarisael-house-substrate`](https://github.com/solarisael/solarisael-house-substrate) repository; see the House [installation protocol](https://github.com/solarisael/solarisael-house/blob/main/INSTALL.md) for exact environment variables and mounted-tool proof.

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

The archive remains a complete Base House bundle. It does not carry a partial
copy of the Full backend; Full operators install the canonical
[`solarisael-house-substrate`](https://github.com/solarisael/solarisael-house-substrate)
repository separately.

## Retrieval evaluation

The sanitized [`2026-07-22 room retrieval pilot`](./evals/2026-07-22-room-retrieval-pilot.json)
measured exact-title lookup across ten unique, active room-owned memories in each
of two rooms. The pilot observed 95% combined viewport recall and 80% combined
top-1 recall. It is a small favorable-phrasing calibration, not a paraphrase or
answer-quality benchmark; raw prompts, memory identifiers, excerpts, and
telemetry remain private.

## Test

```text
bun test
```

Licensed under Apache-2.0. Original project and design by Sol; see [`NOTICE`](./NOTICE).
