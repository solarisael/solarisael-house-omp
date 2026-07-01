// Recall adapter for OMP.
// Silhouette: ask the opencode memory module first, then diagnose/fallback through the DB script.

import { POSTGRES_SOURCE_SCRIPT } from "./constants.ts";
import { loadHouseMemory } from "./core.ts";
import { runWslDiagnostic, windowsPathToWsl } from "./substrate.ts";

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
  const canonMatches = Array.isArray(result?.canonMatches)
    ? result.canonMatches.slice(0, 6).map((m) => ({
      termKey: m?.termKey,
      type: m?.entry?.type,
      summary: m?.entry?.summary,
      files: Array.isArray(m?.entry?.files) ? m.entry.files.slice(0, 3) : [],
    }))
    : [];
  const semanticChunks = Array.isArray(result?.semanticChunks)
    ? result.semanticChunks.slice(0, 5).map((c) => ({
      source_path: c?.source_path,
      heading_path: c?.heading_path,
      sim: c?.sim,
      body: String(c?.body || "").slice(0, 900),
    }))
    : [];
  const contentChunks = Array.isArray(result?.contentChunks)
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

  return {
    ok: Boolean(result?.ok),
    query: result?.query,
    found: Boolean(result?.found),
    source: result?.source,
    canonMatches,
    semanticChunks,
    contentChunks,
    dateMatches,
    queryDates: Array.isArray(result?.queryDates) ? result.queryDates : [],
    ...(taxonomy ? { taxonomy } : {}),
  };
}

async function diagnoseRecallFailure(effectiveRoomDir, room, query) {
  const roomDirWsl = windowsPathToWsl(effectiveRoomDir);
  const scriptWsl = windowsPathToWsl(POSTGRES_SOURCE_SCRIPT);
  const argv = [
    "--cd", "~",
    "python3",
    scriptWsl,
    "--room-dir", roomDirWsl,
    "--mode", "full",
    "--room", room,
    "--semantic-top-k", "1",
    "--semantic-min-sim", "0.50",
    "--content-top-k", "1",
    "--content-min-sim", "0.30",
  ];
  const probe = await runWslDiagnostic({ argv, stdin: query });
  return {
    effectiveRoomDir,
    roomDirWsl,
    postgresSourceScript: POSTGRES_SOURCE_SCRIPT,
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
  const roomDirWsl = windowsPathToWsl(effectiveRoomDir);
  const scriptWsl = windowsPathToWsl(POSTGRES_SOURCE_SCRIPT);
  const argv = [
    "--cd", "~",
    "python3",
    scriptWsl,
    "--room-dir", roomDirWsl,
    "--mode", "full",
    "--room", room,
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
