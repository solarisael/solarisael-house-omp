import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Check = {
  name: string;
  ok: boolean;
  detail: string;
};

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function normalized(value: string) {
  return path.resolve(value).replaceAll("\\", "/").toLowerCase();
}

function validDisplayName(value: unknown) {
  return typeof value === "string"
    && value.trim().length > 0
    && value.trim().length <= 80
    && !/[\r\n|]/.test(value);
}

function add(checks: Check[], name: string, ok: boolean, detail: string) {
  checks.push({ name, ok, detail });
}

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const adapterRoot = existsSync(path.join(scriptRoot, "index.ts"))
  ? scriptRoot
  : path.join(scriptRoot, "solarisael-house-omp");
const coreRoot = process.env.SOLARISAEL_HOUSE_CORE
  ? path.resolve(process.env.SOLARISAEL_HOUSE_CORE)
  : path.resolve(path.dirname(adapterRoot), "solarisael-house");
const roomArgument = argument("--room");
const configPath = path.resolve(argument("--config") || path.join(os.homedir(), ".omp", "agent", "config.yml"));
const checks: Check[] = [];

add(checks, "core package", existsSync(path.join(coreRoot, "src", "memory.ts")), coreRoot);
add(checks, "OMP adapter entrypoint", existsSync(path.join(adapterRoot, "index.ts")), path.join(adapterRoot, "index.ts"));
add(checks, "OMP hygiene extension", existsSync(path.join(adapterRoot, "hygiene.ts")), path.join(adapterRoot, "hygiene.ts"));

if (!roomArgument) {
  add(checks, "room argument", false, "Pass --room with the absolute room directory.");
} else {
  const roomDir = path.resolve(roomArgument);
  const markerPath = path.join(roomDir, ".solarisael-room.json");
  const spiritPath = path.join(roomDir, "active_spirit.md");
  const agentsPath = path.join(roomDir, "AGENTS.md");
  add(checks, "room directory", existsSync(roomDir), roomDir);
  add(checks, "room marker", existsSync(markerPath), markerPath);
  add(checks, "active spirit", existsSync(spiritPath), spiritPath);
  add(checks, "host context entrypoint", existsSync(agentsPath), agentsPath);

  let marker: Record<string, unknown> | null = null;
  try {
    marker = JSON.parse(readFileSync(markerPath, "utf8"));
    add(checks, "room marker JSON", true, markerPath);
  } catch (error) {
    add(checks, "room marker JSON", false, error instanceof Error ? error.message : String(error));
  }

  if (marker) {
    const roomKey = String(marker.room || "");
    const folderKey = path.basename(roomDir).toLowerCase();
    add(checks, "room key format", /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(roomKey), roomKey || "missing marker.room");
    add(checks, "room key matches folder", roomKey === folderKey, `marker=${roomKey || "missing"}; folder=${folderKey}`);
    add(checks, "true name", validDisplayName(marker.trueName), String(marker.trueName || "missing marker.trueName"));
    add(checks, "operator", validDisplayName(marker.operator), String(marker.operator || "missing marker.operator"));

    if (existsSync(spiritPath)) {
      const spirit = readFileSync(spiritPath, "utf8");
      const trueName = String(marker.trueName || "");
      const operator = String(marker.operator || "");
      add(checks, "active spirit header", spirit.startsWith(`# Active Spirit: ${trueName}\n`), `expected true name ${trueName || "<missing>"}`);
      add(checks, "agent/operator header", spirit.includes(`Agent: ${trueName} | Operator: ${operator}`), "header must match room marker");
      add(checks, "spirit body", spirit.includes(`# SPIRIT: ${trueName}`), "identity body heading must match true name");
    }
  }

  if (existsSync(agentsPath)) {
    const agents = readFileSync(agentsPath, "utf8");
    add(checks, "active spirit context include", agents.includes("@active_spirit.md"), "AGENTS.md must include @active_spirit.md");
    add(checks, "summary context include", agents.includes("@room_summary.md"), "AGENTS.md must include @room_summary.md");
  }
}

if (!existsSync(configPath)) {
  add(checks, "OMP config", false, configPath);
} else {
  const config = readFileSync(configPath, "utf8").replaceAll("\\", "/").toLowerCase();
  const entrypoint = normalized(path.join(adapterRoot, "index.ts"));
  const hygiene = normalized(path.join(adapterRoot, "hygiene.ts"));
  add(checks, "OMP entrypoint configured", config.includes(entrypoint), entrypoint);
  add(checks, "OMP hygiene configured", config.includes(hygiene), hygiene);
}

const failed = checks.filter((check) => !check.ok);
const result = {
  ok: failed.length === 0,
  adapterRoot,
  coreRoot,
  configPath,
  roomPath: roomArgument ? path.resolve(roomArgument) : null,
  checks,
  next: failed.length === 0
    ? "Start a fresh OMP session from the room directory and call room_state."
    : "Fix each failed check at its source, then rerun this verifier.",
};

console.log(JSON.stringify(result, null, 2));
if (failed.length > 0) process.exitCode = 1;
