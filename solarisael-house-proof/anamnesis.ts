import { RustJsonlTransport, RustTransportError } from "../rust-transport.ts";
import { discoverRustExecutable } from "../discovery.ts";

const rustAnamnesisTransports = new Map<string, RustJsonlTransport>();
const ANAMNESIS_DEFAULT_LIMIT = 10;
const ANAMNESIS_MAX_LIMIT = 50;

function rustAnamnesisTransport(): RustJsonlTransport | null {
  const executable = discoverRustExecutable();
  if (!executable) return null;
  let transport = rustAnamnesisTransports.get(executable);
  if (!transport) {
    transport = new RustJsonlTransport({ executable });
    rustAnamnesisTransports.set(executable, transport);
  }
  return transport;
}

function evictRustAnamnesisTransport(executable: string, transport: RustJsonlTransport): void {
  if (rustAnamnesisTransports.get(executable) !== transport) return;
  rustAnamnesisTransports.delete(executable);
  transport.close();
}

export function closeRustAnamnesisTransports(): void {
  for (const [executable, transport] of rustAnamnesisTransports) {
    rustAnamnesisTransports.delete(executable);
    transport.close();
  }
}

function rustFailure(error: unknown) {
  if (error instanceof RustTransportError) {
    return { ok: false, error: error.message, code: error.code, retryable: error.retryable, details: error.details };
  }
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

function validRustAnamnesisResult(value: unknown, mode: string, room: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "result must be an object";
  const result = value as Record<string, unknown>;
  if (result.ok !== true || result.mode !== mode || result.room !== room || typeof result.room !== "string" || typeof result.found !== "boolean" || !Array.isArray(result.entries) || !Array.isArray(result.warnings)) {
    return "result must contain ok=true, mode, requested room, found, entries, and warnings";
  }
  if (result.found && !result.entries.every((entry) => entry && typeof entry === "object" && !Array.isArray(entry))) {
    return "found results must contain entry objects";
  }
  if (!result.warnings.every((warning) => typeof warning === "string")) return "result.warnings must contain strings";
  return null;
}
import { loadHouseMemory } from "./core.ts";

const EMPTY = { entries: [], warnings: [] };

export async function queryAnamnesis(effectiveRoomDir, room, options = {}) {
  const mode = options?.mode === "consult" ? "consult" : "wake";
  const query = String(options?.query || "").trim();
  if (mode === "consult" && !query) return { ok: false, mode, ...EMPTY, error: "consult requires a non-empty query" };
  const executable = discoverRustExecutable();
  const configured = Boolean(executable);
  const transport = rustAnamnesisTransport();
  if (transport) {
    const requestedLimit = options?.limit === undefined ? ANAMNESIS_DEFAULT_LIMIT : Number(options.limit);
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(ANAMNESIS_MAX_LIMIT, Math.trunc(requestedLimit))) : ANAMNESIS_DEFAULT_LIMIT;
    const params = {
      room,
      mode,
      ...(mode === "consult" ? { query } : {}),
      limit,
    };
    try {
      const result = await transport.request("anamnesis", params);
      const validationError = validRustAnamnesisResult(result, mode, room);
      if (validationError) {
        evictRustAnamnesisTransport(executable, transport);
        return { ok: false, mode, ...EMPTY, error: `invalid Rust anamnesis result: ${validationError}` };
      }
      return {
        ...result,
        entries: [...result.entries],
        pillars: result.entries.filter((entry) => (entry as Record<string, unknown>).kind === "pillar"),
        cycles: result.entries.filter((entry) => (entry as Record<string, unknown>).kind === "cycle"),
      };
    } catch (error) {
      if (!transport.usable) evictRustAnamnesisTransport(executable, transport);
      return { mode, ...EMPTY, ...rustFailure(error) };
    }
  }
  if (configured) return { ok: false, mode, ...EMPTY, error: "Rust anamnesis transport unavailable" };
  try {
    const memory = await loadHouseMemory();
    if (typeof memory?.runAnamnesisQuery !== "function") {
      return { ok: false, mode, ...EMPTY, error: "runAnamnesisQuery is unavailable" };
    }
    const result = await memory.runAnamnesisQuery(effectiveRoomDir, room, {
      mode,
      ...(mode === "consult" ? { query } : {}),
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
