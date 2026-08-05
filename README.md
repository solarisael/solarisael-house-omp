# The Athanor — OMP adapter

**your OMP room, with memory that doesn't evaporate — start at [The Athanor](https://github.com/solarisael/the-athanor).**
This repository is The Athanor adapter for [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi).

start at the canonical Athanor docs:

- [What The Athanor is](https://github.com/solarisael/the-athanor#readme)
- [AI-guided OMP installation](https://github.com/solarisael/the-athanor/blob/main/INSTALL.md)
- [Room identity guide](https://github.com/solarisael/the-athanor/blob/main/IDENTITY_GUIDE.md)
- [How to use the House day to day](https://github.com/solarisael/the-athanor/blob/main/USAGE.md)

## What this adapter adds

- OMP lifecycle hooks for room context and end-of-session continuity
- Athanor tools for room state, memory, recall, lessons, paper boats, and routing
- room-local conversation logging and compact live context
- a long-lived Rust transport for authoritative AKASHA memory operations
- automatic and agent-initiated recall through the canonical Athanor contracts
- a hygiene extension for keeping host-generated context out of user-authored continuity
- state-conditioned Striatum activation that keeps three to six structurally
  eligible coding or exact-project lessons warm and lets Nemotron rank relevance
  only after scope, project, type, stage, and register rails
- a private-data-free portable bundle, fictional starter room, deterministic installer, and staged release updater
- explicit Vault, AKASHA, and configured-but-degraded status for the optional [public substrate](https://github.com/solarisael/solarisael-house-substrate)

The adapter stays TypeScript for OMP lifecycle integration, room discovery, context shaping, packaging, and installation. Rust owns shared contracts and the authoritative AKASHA process. Rust-first, because the boundary is real.

The adapter fails open: an absent substrate is valid Vault mode, while a configured but unhealthy database, embedder, or Rust executable is reported as degraded rather than mistaken for healthy AKASHA.

## Platform expectations

The current guided portable release targets **Windows with OMP, Bun, and the stable Rust MSVC toolchain**. Vault does not require PostgreSQL or a GPU. AKASHA adds a release-built Windows Rust substrate process connected to PostgreSQL and the embedding service in WSL. Install it from the canonical [`solarisael-house-substrate`](https://github.com/solarisael/solarisael-house-substrate) repository; see the House [installation protocol](https://github.com/solarisael/the-athanor/blob/main/INSTALL.md) for exact environment variables and mounted-tool proof.

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

The archive remains a complete Vault bundle. It does not carry a partial
copy of the AKASHA backend; AKASHA operators install the canonical
[`solarisael-house-substrate`](https://github.com/solarisael/solarisael-house-substrate)
repository separately.

## Release pipeline

`v*` tags and manual release dispatches run the Windows x64 GitHub release job. It builds the Rust substrate, compiles `install.exe` and `update.exe`, packages the core and adapter, runs the release tests, and publishes the resulting archive. The same job emits one immutable `release-manifest.json` containing the channel, semantic version, required substrate schema, platform asset name, SHA-256 hash, and byte size.

The package version must match the requested release version. Stable releases reject prerelease versions; beta and experimental releases require the corresponding semantic-version prerelease marker. See the canonical [installation protocol](https://github.com/solarisael/the-athanor/blob/main/INSTALL.md#release-installation-and-updates) for installer and updater commands.

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
