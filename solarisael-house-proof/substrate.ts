// WSL/substrate interop for the OMP adapter.
// Silhouette: call the house Python scripts and return small JSON-ish results.

import path from "node:path";
import { spawn } from "node:child_process";
import {
  CODING_LESSONS_SCRIPT,
  DIAGNOSTIC_TIMEOUT_MS,
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
    recordMemory: path.join(dir, "record_memory.py"),
    catchBoat: path.join(dir, "catch_boat.py"),
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

export async function writeSessionMemory({ sharedRoot, room, title, body, backup, type = "session", sourcePath, threads = [], timeoutMs = WRITE_TIMEOUT_MS }) {
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
  if (!backup) argv.push("--no-backup");
  const probe = await runWslDiagnostic({ argv, stdin: body, timeoutMs });
  if (probe.timedOut) return { ok: false, error: "record_memory timed out" };
  if (probe.spawnError) return { ok: false, error: probe.spawnError };
  if (probe.code !== 0) return { ok: false, error: String(probe.stderr || "").trim() || `record_memory exited ${probe.code}` };
  const summary = String(probe.stdout || "").trim();
  const idMatch = /id=(\d+)/.exec(summary);
  return { ok: true, id: idMatch ? Number(idMatch[1]) : null, summary, sourcePath: resolvedSourcePath };
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
