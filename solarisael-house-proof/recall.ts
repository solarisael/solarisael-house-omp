// Recall adapter for OMP.
// Silhouette: ask the opencode memory module first, then diagnose/fallback through the DB script.

import path from "node:path";

import { loadHouseCore, loadHouseMemory } from "./core.ts";
import { runWslDiagnostic, substrateConfigurationError, substratePaths, windowsPathToWsl } from "./substrate.ts";
import { RustJsonlTransport, RustTransportError } from "../rust-transport.ts";

async function postgresSourceScript() {
  const core = await loadHouseCore();
  const source = core.POSTGRES_MEMORY_SOURCE_SCRIPT;
  if (typeof source !== "string" || !source.trim()) {
    throw new Error("Solarisael House core does not export POSTGRES_MEMORY_SOURCE_SCRIPT");
  }
  return source;
}

function text(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function strings(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const item of value) {
    const normalized = text(item);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sourcePathKey(value) {
  return text(value).replace(/\\/g, "/").replace(/^house\//i, "").toLowerCase();
}

function matchesQueryTerm(query, term) {
  const needle = text(term).toLowerCase();
  if (!needle) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegExp(needle)}($|[^\\p{L}\\p{N}_])`, "iu").test(text(query).toLowerCase());
}

function isDirectCanonMatch(match, query) {
  return [match?.termKey, ...strings(match?.entry?.aliases)].some((term) => matchesQueryTerm(query, term));
}

function canonFiles(match) {
  return Array.isArray(match?.entry?.files)
    ? match.entry.files.map((entry) => sourcePathKey(entry?.file)).filter(Boolean)
    : [];
}

function canonTouchesCandidate(match, candidatePaths) {
  if (!candidatePaths.size) return false;
  return canonFiles(match).some((file) => candidatePaths.has(file));
}

function compactRetrievalCandidates(result) {
  return Array.isArray(result?.retrievalCandidates)
    ? result.retrievalCandidates.slice(0, 5).map((candidate) => ({
      source_path: candidate?.source_path,
      title: candidate?.title,
      heading_path: candidate?.heading_path,
      sources: strings(candidate?.sources).slice(0, 4),
      score: candidate?.score,
      term_coverage: candidate?.term_coverage,
      matched_terms: strings(candidate?.matched_terms).slice(0, 8),
      missing_terms: strings(candidate?.missing_terms).slice(0, 8),
      reasons: strings(candidate?.reasons).slice(0, 5),
      excerpt: text(candidate?.excerpt).slice(0, 900),
    }))
    : [];
}

function compactTaxonomy(taxonomy) {
  if (!taxonomy || typeof taxonomy !== "object") return null;
  const memoryTypes = Array.isArray(taxonomy.memoryTypes)
    ? taxonomy.memoryTypes.slice(0, 12)
    : [];
  const threadKeys = Array.isArray(taxonomy.threadKeys)
    ? taxonomy.threadKeys.slice(0, 12)
    : [];
  const namedEntities = Array.isArray(taxonomy.namedEntities)
    ? taxonomy.namedEntities.slice(0, 12)
    : [];
  if (!memoryTypes.length && !threadKeys.length && !namedEntities.length) return null;
  return {
    rooms: Array.isArray(taxonomy.rooms) ? taxonomy.rooms : [],
    memoryTypes,
    threadKeys,
    namedEntities,
  };
}

export function compactRecall(result, { includeTaxonomy = false } = {}) {
  const retrievalCandidates = compactRetrievalCandidates(result);
  const candidatePaths = new Set(
    retrievalCandidates.map((candidate) => sourcePathKey(candidate?.source_path)).filter(Boolean),
  );
  const canonMatches = Array.isArray(result?.canonMatches)
    ? result.canonMatches
      .filter((match) => isDirectCanonMatch(match, result?.query) || canonTouchesCandidate(match, candidatePaths))
      .slice(0, 6)
      .map((m) => ({
        termKey: m?.termKey,
        type: m?.entry?.type,
        summary: m?.entry?.summary,
        files: Array.isArray(m?.entry?.files) ? m.entry.files.slice(0, 3) : [],
      }))
    : [];
  const includeRawChunks = retrievalCandidates.length === 0;
  const semanticChunks = includeRawChunks && Array.isArray(result?.semanticChunks)
    ? result.semanticChunks.slice(0, 5).map((c) => ({
      source_path: c?.source_path,
      heading_path: c?.heading_path,
      sim: c?.sim,
      body: String(c?.body || "").slice(0, 900),
    }))
    : [];
  const contentChunks = includeRawChunks && Array.isArray(result?.contentChunks)
    ? result.contentChunks.slice(0, 5).map((c) => ({
      source_path: c?.source_path,
      heading_path: c?.heading_path,
      ws: c?.ws,
      body: String(c?.body || "").slice(0, 900),
    }))
    : [];
  const dateMatches = Array.isArray(result?.dateMatches)
    ? result.dateMatches.slice(0, 5).map((d) => ({
      source_path: d?.source_path,
      title: d?.title,
      dates: d?.dates,
      body_excerpt: String(d?.body_excerpt || "").slice(0, 900),
    }))
    : [];
  const taxonomy = includeTaxonomy ? compactTaxonomy(result?.taxonomy) : null;

  // Cluster telemetry is advisory and fail-open: malformed or absent
  // substrate fields must never affect the base recall payload.
  const staleness = validClusterStaleness(result?.clusterStaleness) ? result.clusterStaleness : null;
  const clusterNudge = staleness && (staleness.built_at === null || staleness.fraction_unseen >= 0.15)
    ? `clusters: ${staleness.built_at === null ? "never built" : `built ${staleness.built_at.slice(0, 10)}`}, `
      + `${staleness.chunks_since_build} chunks since (${Math.round(staleness.fraction_unseen * 100)}% of corpus unseen) — `
      + `wanna do clusters, dummies? (house/substrate/rebuild_clusters.py)`
    : null;

  // Resonance is similarly advisory. Keep the existing eight-profile/three-hot
  // bounds, but never serialize partially malformed telemetry.
  const resonance = validClusterResonance(result?.clusterResonance)
    ? {
      note: "substrate resonance: what the memory space finds near this query — telemetry, not model-internal state",
      profile: result.clusterResonance.profile.slice(0, 8).map((p) => ({
        label: p.label,
        activation: p.activation,
        members: p.member_count,
      })),
      dormantHot: result.clusterResonance.hot.slice(0, 3),
    }
    : null;

  return {
    ok: Boolean(result?.ok),
    query: result?.query,
    found: Boolean(result?.found),
    source: result?.source,
    canonMatches,
    retrievalCandidates,
    semanticChunks,
    contentChunks,
    dateMatches,
    queryDates: Array.isArray(result?.queryDates) ? result.queryDates : [],
    ...(taxonomy ? { taxonomy } : {}),
    ...(clusterNudge ? { clusterNudge } : {}),
    ...(resonance ? { clusterResonance: resonance } : {}),
    ...(result?.memoryHandle ? {
      memoryHandle: {
        ...result.memoryHandle,
        memory: result.memoryHandle.memory
          ? { ...result.memoryHandle.memory, body: String(result.memoryHandle.memory.body || "").slice(0, 6000) }
          : null,
      },
    } : {}),
  };
}

function validClusterStaleness(value) {
  const builtAtValid = value?.built_at === null
    || (typeof value?.built_at === "string" && Number.isFinite(Date.parse(value.built_at)));
  return value && typeof value === "object" && !Array.isArray(value)
    && builtAtValid
    && Number.isInteger(value.chunks_since_build) && value.chunks_since_build >= 0
    && Number.isFinite(value.fraction_unseen) && value.fraction_unseen >= 0 && value.fraction_unseen <= 1;
}

function validClusterHot(value) {
  if (typeof value === "string") return value.length > 0;
  return value && typeof value === "object" && !Array.isArray(value)
    && Number.isInteger(value.cluster_id) && value.cluster_id >= 0
    && typeof value.label === "string"
    && Array.isArray(value.chunks)
    && value.chunks.every((chunk) => chunk && typeof chunk === "object" && !Array.isArray(chunk)
      && typeof chunk.source_path === "string"
      && (chunk.heading_path === null || typeof chunk.heading_path === "string")
      && Number.isFinite(chunk.sim) && chunk.sim >= -1 && chunk.sim <= 1);
}

function validClusterResonance(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Array.isArray(value.profile) && value.profile.length > 0
    && value.profile.every((entry) => entry && typeof entry === "object" && !Array.isArray(entry)
      && typeof entry.label === "string" && entry.label.length > 0
      && Number.isFinite(entry.activation) && entry.activation >= -1 && entry.activation <= 1
      && Number.isInteger(entry.member_count) && entry.member_count >= 0)
    && Array.isArray(value.hot) && value.hot.every(validClusterHot);
}


async function diagnoseRecallFailure(effectiveRoomDir, room, query) {
  const sourceScript = await postgresSourceScript();
  const roomDirWsl = windowsPathToWsl(effectiveRoomDir);
  const scriptWsl = windowsPathToWsl(sourceScript);
  const { dir: substrateDir } = substratePaths(path.dirname(effectiveRoomDir));
  const substrateDirWsl = windowsPathToWsl(substrateDir);
  const argv = [
    "--cd", "~",
    "python3",
    scriptWsl,
    "--room-dir", roomDirWsl,
    "--mode", "full",
    "--room", room,
    "--substrate-dir", substrateDirWsl,
    "--semantic-top-k", "1",
    "--semantic-min-sim", "0.50",
    "--content-top-k", "1",
    "--content-min-sim", "0.30",
  ];
  const probe = await runWslDiagnostic({ argv, stdin: query });
  return {
    effectiveRoomDir,
    roomDirWsl,
    postgresSourceScript: sourceScript,
    postgresSourceScriptWsl: scriptWsl,
    argv,
    probe: {
      timedOut: probe.timedOut,
      spawnError: probe.spawnError,
      code: probe.code,
      stdout: String(probe.stdout || "").slice(0, 1200),
      stderr: String(probe.stderr || "").slice(0, 2000),
    },
  };
}

async function runDirectRecallFallback(effectiveRoomDir, room, query) {
  const configurationError = substrateConfigurationError();
  if (configurationError) return { ok: false, error: configurationError };
  const sourceScript = await postgresSourceScript();
  const roomDirWsl = windowsPathToWsl(effectiveRoomDir);
  const scriptWsl = windowsPathToWsl(sourceScript);
  const { dir: substrateDir } = substratePaths(path.dirname(effectiveRoomDir));
  const substrateDirWsl = windowsPathToWsl(substrateDir);
  const argv = [
    "--cd", "~",
    "python3",
    scriptWsl,
    "--room-dir", roomDirWsl,
    "--mode", "full",
    "--room", room,
    "--substrate-dir", substrateDirWsl,
    "--semantic-top-k", "8",
    "--semantic-min-sim", "0.50",
    "--content-top-k", "8",
    "--content-min-sim", "0.30",
  ];
  const probe = await runWslDiagnostic({ argv, stdin: query });
  if (probe.timedOut || probe.spawnError || probe.code !== 0) {
    return { ok: false, probe, argv, roomDirWsl, scriptWsl };
  }

  try {
    const data = JSON.parse(String(probe.stdout || "{}"));
    const semanticChunks = Array.isArray(data?.semanticChunks) ? data.semanticChunks : [];
    const contentChunks = Array.isArray(data?.contentChunks) ? data.contentChunks : [];
    const dateMatches = Array.isArray(data?.dateMatches) ? data.dateMatches : [];
    const importantIndex = data?.importantIndex || {};
    return {
      ok: true,
      query,
      source: "direct-wsl-fallback",
      importantIndex,
      semanticChunks,
      contentChunks,
      dateMatches,
      queryDates: Array.isArray(data?.queryDates) ? data.queryDates : [],
      taxonomy: data?.taxonomy && typeof data.taxonomy === "object" ? data.taxonomy : null,
      found: semanticChunks.length > 0 || contentChunks.length > 0 || dateMatches.length > 0
        || Object.keys(importantIndex).some((key) => String(query).toLowerCase().includes(key.toLowerCase())),
      diagnostic: { argv, roomDirWsl, scriptWsl, stderr: String(probe.stderr || "").slice(0, 2000) },
    };
  } catch (err) {
    return {
      ok: false,
      error: `direct fallback JSON parse failed: ${err?.message || String(err)}`,
      stdout: String(probe.stdout || "").slice(0, 1200),
      stderr: String(probe.stderr || "").slice(0, 2000),
      argv,
      roomDirWsl,
      scriptWsl,
    };
  }
}

export async function recallWithFallback(effectiveRoomDir, room, query) {
  const configurationError = substrateConfigurationError();
  if (configurationError) {
    return {
      ok: false,
      result: {
        ok: false,
        query,
        error: configurationError,
        fallback: { ok: false, error: configurationError },
      },
    };
  }
  const memory = await loadHouseMemory();
  const result = await memory.runRecallQuery(effectiveRoomDir, room, query);
  if (result?.ok) return { ok: true, result };

  const fallback = await runDirectRecallFallback(effectiveRoomDir, room, query);
  if (fallback.ok) return { ok: true, result: fallback };

  const diagnostic = await diagnoseRecallFailure(effectiveRoomDir, room, query);
  return {
    ok: false,
    result: {
      ok: false,
      query,
      error: result?.error || "unknown recall failure",
      fallback,
      diagnostic,
    },
  };
}

const rustRecallTransports = new Map();

function rustRecallTransport() {
  const executable = String(process.env.SOLARISAEL_HOUSE_RUST || "").trim();
  if (!executable) return null;
  let transport = rustRecallTransports.get(executable);
  if (!transport) {
    transport = new RustJsonlTransport({ executable });
    rustRecallTransports.set(executable, transport);
  }
  return transport;
}

function evictRustRecallTransport(executable, transport) {
  if (rustRecallTransports.get(executable) !== transport) return;
  rustRecallTransports.delete(executable);
  transport.close();
}

export function closeRustRecallTransports() {
  for (const [executable, transport] of rustRecallTransports) {
    rustRecallTransports.delete(executable);
    transport.close();
  }
}

const RECALL_TIMEOUT_MS = 15_000;

function stringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validRustRecallCandidate(candidate) {
  return candidate && typeof candidate === "object" && !Array.isArray(candidate)
    && typeof candidate.source_path === "string"
    && typeof candidate.title === "string"
    && typeof candidate.heading_path === "string"
    && typeof candidate.excerpt === "string"
    && stringArray(candidate.sources)
    && Number.isFinite(candidate.score)
    && Number.isFinite(candidate.term_coverage)
    && stringArray(candidate.matched_terms)
    && stringArray(candidate.missing_terms)
    && stringArray(candidate.reasons);
}

function validRustRecallDateMatch(dateMatch) {
  return dateMatch && typeof dateMatch === "object" && !Array.isArray(dateMatch)
    && typeof dateMatch.body_excerpt === "string";
}

function validRustRecallResult(value, query) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "result must be an object";
  const result = value;
  if (result.ok !== true || result.query !== query || typeof result.found !== "boolean" || typeof result.source !== "string") {
    return "result has invalid ok, query, found, or source";
  }
  for (const field of ["retrievalCandidates", "canonMatches", "semanticChunks", "contentChunks", "dateMatches", "queryDates"]) {
    if (!Array.isArray(result[field])) return `result.${field} must be an array`;
  }
  if (result.dateMatches.length > 5) return "result.dateMatches must contain at most 5 entries";
  if (!result.taxonomy || typeof result.taxonomy !== "object" || Array.isArray(result.taxonomy)) {
    return "result.taxonomy must be an object";
  }
  if (!result.retrievalCandidates.every(validRustRecallCandidate)) {
    return "result.retrievalCandidates entries must contain the exact compactor candidate fields";
  }
  if (!result.dateMatches.every(validRustRecallDateMatch)) {
    return "result.dateMatches entries must contain a string body_excerpt";
  }
  return null;
}

function rustRecallFailure(error) {
  if (error instanceof RustTransportError) {
    return { ok: false, error: error.message, code: error.code, retryable: error.retryable, details: error.details };
  }
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

function stripInvalidClusterTelemetry(result) {
  if (!result || typeof result !== "object") return result;
  const safe = { ...result };
  if (safe.clusterStaleness !== undefined && !validClusterStaleness(safe.clusterStaleness)) {
    delete safe.clusterStaleness;
  }
  if (safe.clusterResonance !== undefined && !validClusterResonance(safe.clusterResonance)) {
    delete safe.clusterResonance;
  }
  return safe;
}

export async function recallWithRouting(effectiveRoomDir, room, query, { signal } = {}) {
  const executable = String(process.env.SOLARISAEL_HOUSE_RUST || "").trim();
  const transport = rustRecallTransport();
  if (!transport) return recallWithFallback(effectiveRoomDir, room, query);
  const params = {
    room,
    query,
    semantic_top_k: 8,
    semantic_min_similarity: 0.50,
    content_top_k: 8,
    content_min_similarity: 0.30,
  };
  try {
    const result = await transport.request("recall", params, { signal, timeoutMs: RECALL_TIMEOUT_MS });
    const validationError = validRustRecallResult(result, query);
    if (validationError) {
      evictRustRecallTransport(executable, transport);
      return { ok: false, result: { ok: false, query, error: `invalid Rust recall result: ${validationError}` } };
    }
    return { ok: true, result: stripInvalidClusterTelemetry(result) };
  } catch (error) {
    if (!transport.usable) evictRustRecallTransport(executable, transport);
    return { ok: false, result: { ok: false, query, ...rustRecallFailure(error) } };
  }
}

