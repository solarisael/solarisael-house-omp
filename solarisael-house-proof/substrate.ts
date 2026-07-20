// WSL/substrate interop for the OMP adapter.
// Silhouette: call the house Python scripts and return small JSON-ish results.

import path from "node:path";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import {
  CODING_LESSONS_SCRIPT,
  DIAGNOSTIC_TIMEOUT_MS,
  HOUSE_CORE_ROOT,
  WRITE_TIMEOUT_MS,
} from "./constants.ts";


export function windowsPathToWsl(value) {
  const source = String(value || "").replace(/\\/g, "/");
  const match = /^([A-Za-z]):\/(.*)$/.exec(source);
  if (!match) return source;
  return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
}

export function substratePaths(sharedRoot) {
  const dir = process.env.SOLARISAEL_SUBSTRATE || path.join(sharedRoot, "house", "substrate");
  return {
    dir,
    health: path.join(dir, "health.py"),
    recordMemory: path.join(dir, "record_memory.py"),
    catchBoat: path.join(dir, "catch_boat.py"),
  };
}

function substrateDegraded({ configured, dir, reason, degradedReasons = [] }) {
  return {
    ok: configured ? false : null,
    configured,
    mode: configured ? "degraded" : "base",
    substrateApi: null,
    path: configured ? dir : null,
    reason,
    degradedReasons,
  };
}

function errorMessage(error) {
  return error?.message || error?.code || String(error);
}

async function pathAccessError(target) {
  try {
    await access(target);
    return null;
  } catch (error) {
    return error;
  }
}

/**
 * Read the canonical public substrate health verdict.
 *
 * The optional substrate never gates Base House behavior. A missing
 * SOLARISAEL_SUBSTRATE is the valid Base mode; a configured path that cannot
 * produce a healthy, compatible verdict is explicitly degraded instead.
 */
export async function substrateHealth(sharedRoot, timeoutMs = DIAGNOSTIC_TIMEOUT_MS) {
  const configuredPath = String(process.env.SOLARISAEL_SUBSTRATE || "").trim();
  if (!configuredPath) {
    return substrateDegraded({
      configured: false,
      dir: null,
      reason: "SOLARISAEL_SUBSTRATE is not configured",
    });
  }

  const { dir, health } = substratePaths(sharedRoot);
  const dirError = await pathAccessError(dir);
  if (dirError) {
    const detail = errorMessage(dirError);
    return substrateDegraded({
      configured: true,
      dir,
      reason: dirError.code === "ENOENT"
        ? `configured substrate path is missing: ${dir}`
        : `configured substrate path is unavailable: ${dir} (${detail})`,
    });
  }
  const healthError = await pathAccessError(health);
  if (healthError) {
    const detail = errorMessage(healthError);
    return substrateDegraded({
      configured: true,
      dir,
      reason: healthError.code === "ENOENT"
        ? `configured substrate health script is missing: ${health}`
        : `configured substrate health script is unavailable: ${health} (${detail})`,
    });
  }

  const argv = ["--cd", "~", "python3", windowsPathToWsl(health)];
  let probe;
  try {
    probe = await runWslDiagnostic({ argv, stdin: "", timeoutMs });
  } catch (error) {
    return substrateDegraded({
      configured: true,
      dir,
      reason: `health.py launch failed: ${errorMessage(error)}`,
    });
  }
  if (probe.timedOut) {
    return substrateDegraded({
      configured: true,
      dir,
      reason: "health.py timed out",
    });
  }
  if (probe.spawnError) {
    return substrateDegraded({
      configured: true,
      dir,
      reason: `health.py launch failed: ${probe.spawnError}`,
    });
  }

  const raw = String(probe.stdout || "").trim();
  let verdict;
  try {
    verdict = JSON.parse(raw);
  } catch (error) {
    return substrateDegraded({
      configured: true,
      dir,
      reason: `health.py returned malformed JSON: ${errorMessage(error)}`,
    });
  }
  if (!verdict || typeof verdict !== "object" || Array.isArray(verdict)) {
    return substrateDegraded({
      configured: true,
      dir,
      reason: "health.py returned an invalid JSON verdict",
    });
  }

  const reportedReasons = Array.isArray(verdict.degradedReasons)
    ? verdict.degradedReasons.filter((reason) => typeof reason === "string" && reason.trim())
    : [];
  const apiCompatible = verdict.substrateApi === 1;
  const full = verdict.ok === true && verdict.mode === "full" && apiCompatible;
  if (full) {
    return {
      ...verdict,
      ok: true,
      configured: true,
      mode: "full",
      path: dir,
      reason: null,
      degradedReasons: reportedReasons,
    };
  }

  let reason = reportedReasons.join("; ");
  if (!apiCompatible) {
    reason = `substrate API mismatch: health.py reported ${String(verdict.substrateApi)}, expected 1`;
  } else if (!reason && verdict.mode !== "full") {
    reason = `health.py reported mode ${String(verdict.mode)}, expected full`;
  } else if (!reason && verdict.ok !== true) {
    reason = "health.py reported an unhealthy substrate";
  } else if (!reason) {
    reason = "health.py returned an incomplete full-mode verdict";
  }
  return {
    ...verdict,
    ok: false,
    configured: true,
    mode: "degraded",
    path: dir,
    reason,
    degradedReasons: reportedReasons.length ? reportedReasons : [reason],
  };
}


export function runWslDiagnostic({ argv, stdin, timeoutMs = DIAGNOSTIC_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const child = spawn("wsl.exe", argv, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ timedOut: true, spawnError: null, code: null, stdout, stderr });
    }, timeoutMs);

    try {
      child.stdin?.end(String(stdin || ""));
    } catch {
      // Diagnostic only. Broken stdin should be reported through process exit.
    }

    child.stdout?.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (err) => finish({
      timedOut: false,
      spawnError: err?.message || String(err),
      code: null,
      stdout,
      stderr,
    }));
    child.on("close", (code) => finish({
      timedOut: false,
      spawnError: null,
      code,
      stdout,
      stderr,
    }));
  });
}

export async function writeSessionMemory({ sharedRoot, room, title, body, backup, type = "session", sourcePath, threads = [], supersedes = [], timeoutMs = WRITE_TIMEOUT_MS }) {
  const { recordMemory } = substratePaths(sharedRoot);
  const resolvedSourcePath = sourcePath
    || `memory/omp_${new Date().toISOString().replace(/[:.]/g, "-")}_${String(title || "memory").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "memory"}.md`;
  const argv = [
    "--cd", "~",
    "python3", windowsPathToWsl(recordMemory),
    "--room", room,
    "--type", String(type || "session"),
    "--title", String(title || "OMP memory"),
    "--source-path", resolvedSourcePath,
    "--body-stdin",
  ];
  for (const thread of Array.isArray(threads) ? threads : []) argv.push("--thread", String(thread));
  for (const memoryId of Array.isArray(supersedes) ? supersedes : []) argv.push("--supersedes", String(memoryId));
  if (!backup) argv.push("--no-backup");
  const probe = await runWslDiagnostic({ argv, stdin: body, timeoutMs });
  if (probe.timedOut) return { ok: false, error: "record_memory timed out" };
  if (probe.spawnError) return { ok: false, error: probe.spawnError };
  if (probe.code !== 0) return { ok: false, error: String(probe.stderr || "").trim() || `record_memory exited ${probe.code}` };
  const summary = String(probe.stdout || "").trim();
  const idMatch = /id=(\d+)/.exec(summary);
  return { ok: true, id: idMatch ? Number(idMatch[1]) : null, summary, sourcePath: resolvedSourcePath };
}

// Lesson-store write path (remember store routing). All lesson scripts share
// the shape: --title inline, lesson text on stdin (--lesson-stdin), optional
// scalar/tag flags built by stores.buildStoreArgs. Body goes via stdin, never
// inline argv — cross-shell-boundary payloads break inline (lesson 163).
export async function writeLessonStore({ sharedRoot, store, title, body, extraArgs = [], timeoutMs = WRITE_TIMEOUT_MS }) {
  const { dir } = substratePaths(sharedRoot);
  const script = path.join(dir, store.script);
  const argv = [
    "--cd", "~",
    "python3", windowsPathToWsl(script),
    "--title", String(title || "OMP lesson"),
    "--lesson-stdin",
    ...extraArgs,
  ];
  if (store.noBackup) argv.push("--no-backup");
  const probe = await runWslDiagnostic({ argv, stdin: body, timeoutMs });
  if (probe.timedOut) return { ok: false, error: `${store.script} timed out` };
  if (probe.spawnError) return { ok: false, error: probe.spawnError };
  if (probe.code !== 0) return { ok: false, error: String(probe.stderr || "").trim() || `${store.script} exited ${probe.code}` };
  const summary = String(probe.stdout || "").trim();
  const idMatch = /id=\s*(\d+)/.exec(summary);
  return { ok: true, id: idMatch ? Number(idMatch[1]) : null, summary };
}

export async function catchBoat(sharedRoot, room) {
  const { catchBoat: script } = substratePaths(sharedRoot);
  const argv = ["--cd", "~", "python3", windowsPathToWsl(script), "--room", room];
  const probe = await runWslDiagnostic({ argv, stdin: "" });
  if (probe.timedOut) return { ok: false, error: "catch_boat timed out" };
  if (probe.spawnError) return { ok: false, error: probe.spawnError };
  if (probe.code !== 0) return { ok: false, error: String(probe.stderr || "").trim() || `catch_boat exited ${probe.code}` };
  try {
    return { ok: true, ...JSON.parse(String(probe.stdout || "{}")) };
  } catch (err) {
    return { ok: false, error: err?.message || String(err), stdout: String(probe.stdout || "").slice(0, 1200) };
  }
}

export function formatWakeContext(boat) {
  const body = String(boat?.body || "").trim();
  if (!body) return "";
  const clipped = body.length > 6000 ? `${body.slice(0, 6000).trimEnd()}\n...[paper boat clipped ${body.length - 6000} chars]` : body;
  return [
    "<system-reminder>",
    "Automatic wake: latest paper boat for this room.",
    boat?.title ? `Title: ${boat.title}` : null,
    boat?.source_path ? `Source: ${boat.source_path}` : null,
    "",
    clipped,
    "</system-reminder>",
  ].filter((line) => line !== null).join("\n");
}

export async function runCodingLessons(effectiveRoomDir, room, shape) {
  const argv = [
    "--cd", "~",
    "python3", windowsPathToWsl(CODING_LESSONS_SCRIPT),
    "--room-dir", windowsPathToWsl(effectiveRoomDir),
    "--shape", String(shape),
    "--room", room,
  ];
  const probe = await runWslDiagnostic({ argv, stdin: "" });
  if (probe.timedOut || probe.spawnError || probe.code !== 0) return { ok: false, lessons: [], taxonomy: null };
  try {
    const parsed = JSON.parse(String(probe.stdout || "{}"));
    return {
      ok: true,
      lessons: Array.isArray(parsed.lessons) ? parsed.lessons : [],
      taxonomy: parsed.taxonomy && typeof parsed.taxonomy === "object" ? parsed.taxonomy : null,
    };
  } catch {
    return { ok: false, lessons: [], taxonomy: null };
  }
}

export async function deleteLesson({ sharedRoot, effectiveRoomDir, kind, id, expectedTitle, timeoutMs = WRITE_TIMEOUT_MS }) {
  const script = path.join(HOUSE_CORE_ROOT, "src", "delete-lesson.py");
  const argv = [
    "--cd", "~",
    "python3", windowsPathToWsl(script),
    "--room-dir", windowsPathToWsl(effectiveRoomDir),
    "--kind", String(kind),
    "--id", String(id),
    "--expected-title", String(expectedTitle),
  ];
  const probe = await runWslDiagnostic({ argv, stdin: "", timeoutMs });
  if (probe.timedOut) return { ok: false, deleted: false, error: "delete-lesson timed out" };
  if (probe.spawnError) return { ok: false, deleted: false, error: probe.spawnError };
  if (probe.code !== 0) return { ok: false, deleted: false, error: String(probe.stderr || "").trim() || `delete-lesson exited ${probe.code}` };
  try {
    const parsed = JSON.parse(String(probe.stdout || "{}"));
    if (parsed?.ok !== true || parsed?.deleted !== true) return { ok: false, deleted: false, ...parsed };
    return { ...parsed, ok: true, deleted: true };
  } catch (err) {
    return { ok: false, deleted: false, error: err?.message || String(err), stdout: String(probe.stdout || "").slice(0, 1200) };
  }
}
export async function updateLesson({
  effectiveRoomDir,
  kind,
  id,
  expectedTitle,
  patch = {},
  timeoutMs = WRITE_TIMEOUT_MS,
}) {
  const patchKeys = ["title", "body", "shape", "triggerContext", "tags", "voice", "scope", "project", "proofPattern", "negationOf"];
  if (!patchKeys.some((key) => Object.prototype.hasOwnProperty.call(patch, key) && patch[key] !== undefined)) {
    return { ok: false, updated: false, error: "at least one update field is required" };
  }
  const script = path.join(HOUSE_CORE_ROOT, "src", "update-lesson.py");
  const argv = [
    "--cd", "~",
    "python3", windowsPathToWsl(script),
    "--room-dir", windowsPathToWsl(effectiveRoomDir),
    "--kind", String(kind),
    "--id", String(id),
    "--expected-title", String(expectedTitle),
  ];
  const values = [
    ["title", "--title"],
    ["shape", "--shape"],
    ["triggerContext", "--trigger-context"],
    ["voice", "--voice"],
    ["scope", "--scope"],
    ["project", "--project"],
    ["proofPattern", "--proof-pattern"],
    ["negationOf", "--negation-of"],
  ];
  for (const [key, flag] of values) {
    if (Object.prototype.hasOwnProperty.call(patch, key) && patch[key] !== null && patch[key] !== undefined) {
      argv.push(flag, String(patch[key]));
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, "negationOf") && patch.negationOf === null) {
    argv.push("--clear-negation-of");
  }
  if (Object.prototype.hasOwnProperty.call(patch, "tags")) {
    for (const tag of Array.isArray(patch.tags) ? patch.tags : []) argv.push("--tag", String(tag));
  }
  const hasBody = Object.prototype.hasOwnProperty.call(patch, "body");
  if (hasBody) argv.push("--lesson-stdin");
  const probe = await runWslDiagnostic({ argv, stdin: hasBody ? String(patch.body ?? "") : "", timeoutMs });
  if (probe.timedOut) return { ok: false, updated: false, error: "update-lesson timed out" };
  if (probe.spawnError) return { ok: false, updated: false, error: probe.spawnError };
  if (probe.code !== 0) return { ok: false, updated: false, error: String(probe.stderr || "").trim() || `update-lesson exited ${probe.code}` };
  try {
    const parsed = JSON.parse(String(probe.stdout || "{}"));
    if (parsed?.ok !== true || parsed?.updated !== true) return { ...parsed, ok: false, updated: false };
    return { ...parsed, ok: true, updated: true };
  } catch (err) {
    return { ok: false, updated: false, error: err?.message || String(err), stdout: String(probe.stdout || "").slice(0, 1200) };
  }
}

async function runCabinetWriter({ sharedRoot, room, payload, append = false, timeoutMs = WRITE_TIMEOUT_MS }) {
  const { dir } = substratePaths(sharedRoot);
  const script = path.join(dir, "record_cabinet_entry.py");
  const temp = await mkdtemp(path.join(tmpdir(), "anamnesis-"));
  const files = new Map();
  try {
    const argv = ["--cd", "~", "python3", windowsPathToWsl(script), "--room", String(room), append ? "append-rep" : "add"];
    const add = (flag, value) => { if (value !== undefined && value !== null && String(value) !== "") argv.push(flag, String(value)); };
    const addFile = async (key, flag, value) => {
      if (value === undefined || value === null || String(value) === "") return;
      const target = path.join(temp, `${key}.txt`);
      await writeFile(target, String(value), "utf8");
      files.set(key, target);
      argv.push(flag, windowsPathToWsl(target));
    };
    if (append) {
      add("--title", payload?.title);
      add("--rep-number", payload?.repNumber);
      add("--occurred-on", payload?.occurredOn);
      await addFile("how-it-went", "--how-it-went-file", payload?.howItWent);
      await addFile("portal-pull", "--portal-pull-file", payload?.portalPull);
      await addFile("lighter", "--lighter-file", payload?.lighter);
      for (const source of Array.isArray(payload?.sourcePaths) ? payload.sourcePaths : []) add("--source-path", source);
    } else {
      add("--kind", payload?.kind);
      add("--fidelity", payload?.fidelity);
      add("--activation", payload?.activation);
      if (payload?.dormant) argv.push("--dormant");
      add("--title", payload?.title); add("--shape", payload?.shape);
      if (payload?.allowEmptyCycle) argv.push("--allow-empty-cycle");
      await addFile("ramp", "--ramp-file", payload?.ramp);
      await addFile("counsel", "--counsel-file", payload?.counsel);
      await addFile("peak", "--peak-file", payload?.peak);
      await addFile("beginning", "--beginning-file", payload?.beginning);
      await addFile("verify-note", "--verify-note-file", payload?.verifyNote);
      for (const value of Array.isArray(payload?.canon) ? payload.canon : []) add("--canon", value);
      for (const value of Array.isArray(payload?.sourcePaths) ? payload.sourcePaths : []) add("--source-path", value);
      for (const value of Array.isArray(payload?.tags) ? payload.tags : []) add("--tag", value);
      if (payload?.seedRep) {
        add("--seed-rep-number", payload.seedRep.number);
        add("--seed-rep-on", payload.seedRep.occurredOn);
        await addFile("seed-rep-how", "--seed-rep-how-file", payload.seedRep.howItWent);
        await addFile("seed-rep-portal", "--seed-rep-portal-file", payload.seedRep.portalPull);
        await addFile("seed-rep-lighter", "--seed-rep-lighter-file", payload.seedRep.lighter);
      }
    }
    const probe = await runWslDiagnostic({ argv, stdin: "", timeoutMs });
    if (probe.timedOut) return { ok: false, error: "record_cabinet_entry timed out" };
    if (probe.spawnError) return { ok: false, error: probe.spawnError };
    if (probe.code !== 0) return { ok: false, error: String(probe.stderr || "").trim() || `record_cabinet_entry exited ${probe.code}` };
    const summary = String(probe.stdout || "").trim();
    const idPattern = append ? /cabinet rep:\s*id=(\d+)/i : /cabinet add:\s*id=(\d+)/i;
    const idMatch = idPattern.exec(summary);
    return {
      ok: true,
      ...(idMatch ? { id: Number(idMatch[1]) } : {}),
      summary: summary.slice(0, 1200),
    };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}

export function writeAnamnesisDrawer({ sharedRoot, room, payload, timeoutMs = WRITE_TIMEOUT_MS }) {
  return runCabinetWriter({ sharedRoot, room, payload, timeoutMs });
}

export function appendAnamnesisRep({ sharedRoot, room, payload, timeoutMs = WRITE_TIMEOUT_MS }) {
  return runCabinetWriter({ sharedRoot, room, payload, append: true, timeoutMs });
}
