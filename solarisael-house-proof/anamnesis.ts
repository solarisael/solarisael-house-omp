import { loadHouseMemory } from "./core.ts";

const EMPTY = { entries: [], warnings: [] };

export async function queryAnamnesis(effectiveRoomDir, room, options = {}) {
  const mode = options?.mode === "consult" ? "consult" : "wake";
  try {
    if (mode === "consult" && !String(options?.query || "").trim()) {
      return { ok: false, mode, ...EMPTY, error: "consult requires a non-empty query" };
    }
    const memory = await loadHouseMemory();
    if (typeof memory?.runAnamnesisQuery !== "function") {
      return { ok: false, mode, ...EMPTY, error: "runAnamnesisQuery is unavailable" };
    }
    const result = await memory.runAnamnesisQuery(effectiveRoomDir, room, {
      mode,
      ...(mode === "consult" ? { query: String(options.query).trim() } : {}),
      ...(options?.limit !== undefined ? { limit: Number(options.limit) } : {}),
    });
    return {
      ok: result?.ok === true,
      mode,
      entries: Array.isArray(result?.entries) ? result.entries : [],
      warnings: Array.isArray(result?.warnings) ? result.warnings.map(String) : [],
      ...(result?.error ? { error: String(result.error) } : {}),
    };
  } catch (err) {
    return { ok: false, mode, ...EMPTY, error: err?.message || String(err) };
  }
}

function list(value) { return Array.isArray(value) ? value.filter(Boolean).map(String) : []; }
function text(value) { return String(value || "").trim(); }

export function formatAnamnesisContext(result, { automatic = false } = {}) {
  if (!result?.ok || !Array.isArray(result.entries) || !result.entries.length) return "";
  const lines = ["<system-reminder>", automatic ? "Automatic Anamnesis counsel (not present-state truth)." : "Anamnesis Cabinet counsel."];
  if (automatic) {
    lines.push("The Cabinet is counsel, not present-state truth.", "Pillars are standing places.", "Active cycles are prior patterns to verify against the live turn.", "Never assert a cycle is active merely because it loaded.");
  }
  lines.push("Fidelity: record=true-as-said; raw-material=true-as-reforged.", "Source paths are citations.", "");
  for (const entry of result.entries) {
    const kind = text(entry.kind) || "entry";
    const fidelity = text(entry.fidelity);
    const activation = text(entry.activation);
    const state = entry.active === true ? "active" : entry.active === false ? "inactive" : "unspecified";
    lines.push(`[${kind}${fidelity ? `; fidelity=${fidelity}` : ""}${activation ? `; activation=${activation}` : ""}; state=${state}] ${text(entry.title) || "(untitled)"}`);
    for (const [label, value] of [["Shape", entry.shape], ["Peak", entry.peak], ["Beginning", entry.beginning], ["Ramp", entry.ramp], ["Counsel", entry.counsel], ["Verify", entry.verify_note]]) {
      if (text(value)) lines.push(`${label}: ${text(value)}`);
    }
    const tags = list(entry.tags); if (tags.length) lines.push(`Tags: ${tags.join(", ")}`);
    const canon = list(entry.canon_links); if (canon.length) lines.push(`Canon: ${canon.join(", ")}`);
    const sources = list(entry.source_paths); if (sources.length) lines.push(`Sources: ${sources.join(", ")}`);
    for (const rep of Array.isArray(entry.reps) ? entry.reps : []) {
      lines.push(`Rep ${text(rep.rep_number) || "?"}${text(rep.occurred_on) ? ` (${text(rep.occurred_on)})` : ""}: ${text(rep.how_it_went)}`);
      if (text(rep.portal_pull)) lines.push(`Portal pull: ${text(rep.portal_pull)}`);
      if (text(rep.lighter)) lines.push(`Lighter: ${text(rep.lighter)}`);
      if (text(rep.source_path)) lines.push(`Rep source: ${text(rep.source_path)}`);
    }
    lines.push("");
  }
  if (Array.isArray(result.warnings) && result.warnings.length) lines.push(`Warnings: ${result.warnings.map(String).join(" | ")}`);
  lines.push("</system-reminder>");
  const output = lines.join("\n");
  if (automatic && output.length > 8000) {
    const suffix = "\n...[anamnesis context clipped]\n</system-reminder>";
    return `${output.slice(0, 8000 - suffix.length).trimEnd()}${suffix}`;
  }
  return output;
}
