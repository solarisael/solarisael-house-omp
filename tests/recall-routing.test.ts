import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { RustJsonlTransport, RustTransportError } from "../rust-transport.ts";
import { closeRustRecallTransports, recallWithRouting } from "../solarisael-house-proof/recall.ts";

const originalRust = process.env.SOLARISAEL_HOUSE_RUST;
const originalRequest = RustJsonlTransport.prototype.request;

const result = (query: string) => ({
  ok: true,
  query,
  found: true,
  source: "rust-postgres",
  retrievalCandidates: [],
  canonMatches: [],
  semanticChunks: [],
  contentChunks: [],
  dateMatches: [],
  queryDates: [],
  taxonomy: { memoryTypes: ["memory"], threadKeys: [], namedEntities: [] },
});

describe("Rust recall routing", () => {
  beforeEach(() => { process.env.SOLARISAEL_HOUSE_RUST = process.execPath; });
  afterEach(() => {
    RustJsonlTransport.prototype.request = originalRequest;
    closeRustRecallTransports();
    if (originalRust === undefined) delete process.env.SOLARISAEL_HOUSE_RUST;
    else process.env.SOLARISAEL_HOUSE_RUST = originalRust;
  });

  test("sends protocol recall params and accepts an authoritative result", async () => {
    let observed: unknown;
    RustJsonlTransport.prototype.request = async function (method, params, options) {
      observed = { method, params, options };
      return result("alpha");
    };
    const routed = await recallWithRouting("room-dir", "example", "alpha");
    expect(routed).toEqual({ ok: true, result: result("alpha") });
    expect(observed).toMatchObject({
      method: "recall",
      params: {
        room: "example",
        query: "alpha",
        semantic_top_k: 8,
        semantic_min_similarity: 0.5,
        content_top_k: 8,
        content_min_similarity: 0.3,
      },
      options: { timeoutMs: 120000 },
    });
  });

  test("passes caller cancellation alongside the bounded timeout", async () => {
    let observed: any;
    RustJsonlTransport.prototype.request = async function (method, params, options) {
      observed = { method, params, options };
      return result("alpha");
    };
    const controller = new AbortController();
    await recallWithRouting("room-dir", "example", "alpha", { signal: controller.signal });
    expect(observed.options).toMatchObject({ signal: controller.signal, timeoutMs: 120000 });
    expect(observed.options.settleDefinitively).toBeUndefined();
  });

  test("accepts the exact candidate shape consumed by the compactor", async () => {
    RustJsonlTransport.prototype.request = async function () {
      return {
        ...result("alpha"),
        retrievalCandidates: [{
          source_path: "memory/alpha.md",
          title: "Alpha",
          heading_path: "Notes",
          excerpt: "alpha excerpt",
          sources: ["semantic"],
          score: 0.8,
          term_coverage: 1,
          matched_terms: ["alpha"],
          missing_terms: [],
          reasons: ["semantic search"],
        }],
      };
    };
    await expect(recallWithRouting("room-dir", "example", "alpha")).resolves.toMatchObject({ ok: true });
  });

  test("rejects malformed results before compaction", async () => {
    RustJsonlTransport.prototype.request = async function () {
      return { ok: true, query: "alpha", found: true, source: "rust-postgres" };
    };
    const routed = await recallWithRouting("room-dir", "example", "alpha");
    expect(routed.ok).toBe(false);
    expect(routed.result.error).toContain("result.retrievalCandidates must be an array");
  });

  test("rejects missing taxonomy", async () => {
    RustJsonlTransport.prototype.request = async function () {
      return { ...result("alpha"), taxonomy: null };
    };
    const routed = await recallWithRouting("room-dir", "example", "alpha");
    expect(routed.ok).toBe(false);
    expect(routed.result.error).toContain("result.taxonomy must be an object");
  });

  test("rejects malformed candidate and date elements", async () => {
    RustJsonlTransport.prototype.request = async function () {
      return {
        ...result("alpha"),
        retrievalCandidates: [{ matched_terms: ["alpha"], missing_terms: "beta" }],
        dateMatches: [{ body_excerpt: 42 }],
      };
    };
    const routed = await recallWithRouting("room-dir", "example", "alpha");
    expect(routed.ok).toBe(false);
    expect(routed.result.error).toContain("exact compactor candidate fields");
  });

  test("evicts an unusable transport so the next request respawns it", async () => {
    let calls = 0;
    RustJsonlTransport.prototype.request = async function () {
      calls += 1;
      if (calls === 1) {
        this.close();
        throw new Error("worker exited");
      }
      return result("alpha");
    };
    await expect(recallWithRouting("room-dir", "example", "alpha")).resolves.toMatchObject({ ok: false });
    await expect(recallWithRouting("room-dir", "example", "alpha")).resolves.toEqual({ ok: true, result: result("alpha") });
    expect(calls).toBe(2);
  });

  test("surfaces structured Rust errors without fallback", async () => {
    RustJsonlTransport.prototype.request = async function () {
      throw new RustTransportError({ code: "postgres_unavailable", message: "database down", retryable: false });
    };
    const routed = await recallWithRouting("room-dir", "example", "alpha");
    expect(routed).toMatchObject({
      ok: false,
      result: { ok: false, query: "alpha", error: "database down", code: "postgres_unavailable", retryable: false },
    });
  });
  test("preserves valid cluster telemetry while stripping malformed advisory fields", async () => {
    RustJsonlTransport.prototype.request = async function () {
      return {
        ...result("alpha"),
        clusterStaleness: { built_at: "2026-07-01T00:00:00Z", chunks_since_build: 4, fraction_unseen: 0.2 },
        clusterResonance: {
          profile: [{ cluster_id: 1, label: "alpha", member_count: 3, activation: 0.8 }],
          hot: [{ cluster_id: 1, label: "alpha", chunks: [{ source_path: "memory/a.md", heading_path: null, sim: 0.7 }] }],
        },
      };
    };
    const valid = await recallWithRouting("room-dir", "example", "alpha");
    expect(valid).toMatchObject({ ok: true, result: { clusterStaleness: { fraction_unseen: 0.2 }, clusterResonance: { profile: [{ label: "alpha" }] } } });

    RustJsonlTransport.prototype.request = async function () {
      return {
        ...result("alpha"),
        clusterStaleness: { built_at: "not-a-date", chunks_since_build: -1, fraction_unseen: 4 },
        clusterResonance: { profile: [{ label: "bad", member_count: "3", activation: NaN }], hot: [{ cluster_id: 1, label: "bad", chunks: [{ source_path: "memory/a.md", heading_path: 42, sim: 0.7 }] }] },
      };
    };
    const malformed = await recallWithRouting("room-dir", "example", "alpha");
    expect(malformed).toEqual({ ok: true, result: result("alpha") });
  });

});

test("manual and automatic consumers use the single routing seam", async () => {
  const tools = await readFile(path.join(import.meta.dir, "..", "solarisael-house-proof", "tools.ts"), "utf8");
  const index = await readFile(path.join(import.meta.dir, "..", "index.ts"), "utf8");
  expect(tools).toContain("recallWithRouting");
  expect(tools).not.toContain("recallWithFallback");
  expect(index).toContain("recallWithRouting");
  expect(index).not.toContain("recallWithFallback");
});
