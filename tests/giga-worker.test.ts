import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  __gigaTest,
  buildGigaConversationWindow,
  buildGigaProcessPacket,
  closeGigaTransports,
  ingestGigaLoggedTurnsDetached,
} from "../giga.ts";

const originalEnabled = process.env.SOLARISAEL_GIGA_ENABLED;
const originalProject = process.env.SOLARISAEL_GIGA_PROJECT_KEY;

function hash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function turn(sourceID: string, text: string, role: "user" | "assistant" = "user") {
  return {
    role,
    text,
    sourceID,
    contentHash: hash(text),
    sessionID: "session-1",
    sourceTimestamp: "2026-07-24T12:00:00Z",
    hasStableID: true,
  };
}

beforeEach(() => {
  delete process.env.SOLARISAEL_GIGA_PROJECT_KEY;
  __gigaTest.resetState();
});

afterEach(async () => {
  if (originalEnabled === undefined) delete process.env.SOLARISAEL_GIGA_ENABLED;
  else process.env.SOLARISAEL_GIGA_ENABLED = originalEnabled;
  if (originalProject === undefined) delete process.env.SOLARISAEL_GIGA_PROJECT_KEY;
  else process.env.SOLARISAEL_GIGA_PROJECT_KEY = originalProject;
  await closeGigaTransports();
  __gigaTest.resetState();
});

describe("GIGA OMP adapter packet", () => {
  test("constructs one bounded exact-source packet from durable logged turns", () => {
    const turns = [turn("turn-1", "Keep this boundary."), turn("turn-2", "Understood.", "assistant")];
    const event = buildGigaConversationWindow({ cwd: process.cwd() }, turns)!;

    expect(event.source_refs.map((source) => ({ source_id: source.source_id, content_hash: source.content_hash }))).toEqual([
      { source_id: "turn-1", content_hash: hash("Keep this boundary.") },
      { source_id: "turn-2", content_hash: hash("Understood.") },
    ]);
    expect(buildGigaProcessPacket(event, turns)).toEqual({
      event_id: event.event_id,
      sources: [
        { source_id: "turn-1", text: "Keep this boundary." },
        { source_id: "turn-2", text: "Understood." },
      ],
    });
  });

  test("rejects caller substitutions, stale hashes, and oversized source text", () => {
    const exact = turn("turn-1", "Exact source.");
    const event = buildGigaConversationWindow({ cwd: process.cwd() }, [exact])!;

    expect(buildGigaProcessPacket(event, [{ ...exact, text: "Substituted source." }])).toBeNull();
    expect(buildGigaProcessPacket(event, [{ ...exact, sourceID: "caller-source" }])).toBeNull();
    const oversized = turn("turn-large", "x".repeat(8_001));
    const oversizedEvent = buildGigaConversationWindow({ cwd: process.cwd() }, [oversized])!;
    expect(buildGigaProcessPacket(oversizedEvent, [oversized])).toBeNull();
  });

  test("uses trusted room context and configured project scope, not packet input", () => {
    process.env.SOLARISAEL_GIGA_PROJECT_KEY = "trusted-project";
    const event = buildGigaConversationWindow({ cwd: process.cwd() }, [turn("turn-1", "Project rule.")])!;
    const packet = buildGigaProcessPacket(event, [turn("turn-1", "Project rule.")])!;

    expect(event.room).toBeTruthy();
    expect(event.project_keys).toEqual(["trusted-project"]);
    expect(Object.keys(packet).sort()).toEqual(["event_id", "sources"]);
    expect(Object.keys(packet.sources[0]).sort()).toEqual(["source_id", "text"]);
  });
});

describe("GIGA fail-open lifecycle", () => {
  test("disabled or malformed background work never throws into context generation", () => {
    process.env.SOLARISAEL_GIGA_ENABLED = "0";
    expect(() => ingestGigaLoggedTurnsDetached({ cwd: process.cwd() }, [turn("turn-1", "Exact source.")])).not.toThrow();
    process.env.SOLARISAEL_GIGA_ENABLED = "1";
    expect(() => ingestGigaLoggedTurnsDetached({ cwd: process.cwd() }, [{ ...turn("turn-1", "Exact source."), contentHash: "stale" }])).not.toThrow();
  });

  test("shutdown waits for tracked detached Rust processing before closing", async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((done) => { resolve = done; });
    __gigaTest.trackGigaProcess("event-1", pending);
    const closing = closeGigaTransports();
    let closed = false;
    void closing.then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    resolve();
    await closing;
    expect(closed).toBe(true);
  });
});
