import path from "node:path";
import { HOUSE_CORE_ROOT, DIAGNOSTIC_TIMEOUT_MS } from "./constants.ts";
import { runWslDiagnostic, windowsPathToWsl } from "./substrate.ts";

export type LessonContextInput = {
  effectiveRoomDir: string;
  room: string;
  projects?: string[];
  shapes?: string[];
  terms?: string[];
  limit?: number;
};

export type LessonContext = {
  codingLessons: unknown[];
  projectLessons: unknown[];
  match: Record<string, unknown>;
};

const EMPTY: LessonContext = {
  codingLessons: [], projectLessons: [], match: { scopes: [], projects: [], limit: 0 },
};

/** Invoke the canonical structured query over the existing WSL substrate boundary. */
export async function runLessonContext(input: LessonContextInput): Promise<LessonContext> {
  const script = path.join(HOUSE_CORE_ROOT, "src", "lesson-context.py");
  const argv = ["--cd", "~", "python3", windowsPathToWsl(script),
    "--room-dir", windowsPathToWsl(input.effectiveRoomDir), "--room", String(input.room || "shared")];
  for (const project of input.projects || []) argv.push("--project", String(project));
  for (const shape of input.shapes || []) argv.push("--shape", String(shape));
  for (const term of input.terms || []) argv.push("--term", String(term));
  argv.push("--limit", String(input.limit ?? 8));
  try {
    const probe = await runWslDiagnostic({ argv, stdin: "", timeoutMs: DIAGNOSTIC_TIMEOUT_MS });
    if (probe.timedOut || probe.spawnError || probe.code !== 0) return EMPTY;
    const parsed = JSON.parse(String(probe.stdout || "{}"));
    return {
      codingLessons: Array.isArray(parsed.codingLessons) ? parsed.codingLessons : [],
      projectLessons: Array.isArray(parsed.projectLessons) ? parsed.projectLessons : [],
      match: parsed.match && typeof parsed.match === "object" ? parsed.match : {},
    };
  } catch {
    return EMPTY;
  }
}
