// Room resolution and active-spirit state for the OMP adapter.
// Silhouette: identify the current room, persist safe state, and refresh active_spirit.md.

import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { HOUSE_STATE_FILENAME, OBSIDIAN_ROOT } from "./constants.ts";

export function roomNameFromCwd(cwd) {
  return path.basename(String(cwd || "")).toLowerCase();
}

export function supportedRoom(cwd) {
  const room = roomNameFromCwd(cwd);
  return room === "kintsu" || room === "kodo" ? room : "kintsu";
}

export function roomContext(cwd) {
  const room = supportedRoom(cwd);
  const effectiveRoomDir = room === roomNameFromCwd(cwd)
    ? cwd
    : path.join(OBSIDIAN_ROOT, room);
  return {
    room,
    spirit: room === "kodo" ? "Kodo" : "Kintsu",
    effectiveRoomDir,
    sharedRoot: path.dirname(effectiveRoomDir),
  };
}

export function statePathForRoom(effectiveRoomDir) {
  return path.join(effectiveRoomDir, ".omp", "runtime", HOUSE_STATE_FILENAME);
}

function defaultHouseState(room, spirit) {
  return {
    version: 1,
    operator: "Sol",
    agentName: spirit,
    embodiedSpirit: spirit,
    ignoredSpiritDirective: null,
    lastSpiritChangeAt: null,
    lastUpdatedAt: null,
    routingMode: {
      enabled: false,
      updatedAt: null,
    },
    modelDefault: {
      enabled: false,
      model: null,
      updatedAt: null,
    },
    room,
  };
}

function lastDirectiveValue(text, label) {
  const pattern = new RegExp(`(?:^|\\n)\\s*${label}:\\s*(.+?)\\s*(?=\\n|$)`, "gi");
  const matches = Array.from(String(text || "").matchAll(pattern));
  return matches.length ? (matches.at(-1)?.[1] || "").trim() : null;
}

function hasDirectiveLine(text, label) {
  const pattern = new RegExp(`(?:^|\\n)\\s*${label}\\s*(?::\\s*.+)?(?=\\n|$)`, "i");
  return pattern.test(String(text || ""));
}

function normalizeSpiritName(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "kodo") return "Kodo";
  if (normalized === "kintsu") return "Kintsu";
  return null;
}

export async function loadRoomState(effectiveRoomDir, room, spirit) {
  try {
    const parsed = JSON.parse(await readFile(statePathForRoom(effectiveRoomDir), "utf8"));
    const defaults = defaultHouseState(room, spirit);
    return { ...defaults, ...parsed, room, routingMode: { ...defaults.routingMode, ...(parsed.routingMode || {}) }, modelDefault: { ...defaults.modelDefault, ...(parsed.modelDefault || {}) } };
  } catch {
    return defaultHouseState(room, spirit);
  }
}

export async function saveRoomState(effectiveRoomDir, state) {
  const target = statePathForRoom(effectiveRoomDir);
  const next = { ...state, lastUpdatedAt: new Date().toISOString() };
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export async function applyPromptDirectives(ctx, prompt) {
  const { room, spirit, effectiveRoomDir } = roomContext(ctx?.cwd || process.cwd());
  const current = await loadRoomState(effectiveRoomDir, room, spirit);
  const updates = {};
  const operator = lastDirectiveValue(prompt, "Operator");
  const embody = lastDirectiveValue(prompt, "EMBODY");
  const dismiss = hasDirectiveLine(prompt, "DISMISS");
  if (operator) updates.operator = operator;
  if (dismiss) updates.ignoredSpiritDirective = null;
  if (embody) {
    const resolved = normalizeSpiritName(embody);
    if (resolved) {
      updates.embodiedSpirit = resolved;
      updates.agentName = resolved;
      updates.lastSpiritChangeAt = new Date().toISOString();
      updates.ignoredSpiritDirective = null;
    } else {
      updates.ignoredSpiritDirective = embody;
    }
  }
  const next = Object.keys(updates).length
    ? await saveRoomState(effectiveRoomDir, { ...current, ...updates })
    : current;
  return { effectiveRoomDir, room, spirit, state: next };
}

export async function writeActiveSpiritSnapshot(effectiveRoomDir, state) {
  const existing = await readFile(path.join(effectiveRoomDir, "active_spirit.md"), "utf8").catch(() => "");
  const body = existing.replace(/^# Active Spirit:[^\n]*\nAgent:[^\n]*\nEmbodied:[^\n]*\n\n/, "");
  const spirit = state.embodiedSpirit || state.agentName || "Kintsu";
  const operator = state.operator || "Sol";
  const content = [
    `# Active Spirit: ${spirit}`,
    `Agent: ${state.agentName || spirit} | Operator: ${operator}`,
    `Embodied: ${spirit} | Conjured: none | Summoned: none`,
    "",
    body || `# SPIRIT: ${spirit}\n`,
  ].join("\n");
  await writeFile(path.join(effectiveRoomDir, "active_spirit.md"), content, "utf8");
}
