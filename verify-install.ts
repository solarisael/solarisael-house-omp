import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { substrateHealth } from "./solarisael-house-proof/substrate.ts";

type Check = {
  name: string;
  ok: boolean;
  detail: string;
};

type CompatibilityContract = Record<string, unknown>;
type VerificationMode = "Base" | "Full" | "degraded";


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

function readJson(filePath: string): CompatibilityContract {
  return JSON.parse(readFileSync(filePath, "utf8")) as CompatibilityContract;
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
const substrateArgument = argument("--substrate");
const substrateSetting = substrateArgument || process.env.SOLARISAEL_SUBSTRATE || null;
const substrateConfigured = Boolean(substrateSetting && substrateSetting.trim());
const substrateRoot = substrateConfigured ? path.resolve(substrateSetting as string) : null;
const contractPath = substrateRoot ? path.join(substrateRoot, "compatibility.json") : null;
if (substrateRoot) process.env.SOLARISAEL_SUBSTRATE = substrateRoot;
const checks: Check[] = [];
let compatibilityContract: CompatibilityContract | null = null;
let compatibleApis = false;
let runtimeHealth: {
  ok: boolean | null;
  state: string;
  detail: string;
  verdict: Record<string, unknown> | null;
} = {
  ok: null,
  state: "not-configured",
  detail: "Substrate is not configured.",
  verdict: null,
};

add(checks, "core package", existsSync(path.join(coreRoot, "src", "memory.ts")), coreRoot);
add(checks, "OMP adapter entrypoint", existsSync(path.join(adapterRoot, "index.ts")), path.join(adapterRoot, "index.ts"));
add(checks, "OMP hygiene extension", existsSync(path.join(adapterRoot, "hygiene.ts")), path.join(adapterRoot, "hygiene.ts"));

if (substrateConfigured) {
  add(checks, "substrate directory", existsSync(substrateRoot as string), substrateRoot as string);

  if (!contractPath || !existsSync(contractPath)) {
    add(checks, "compatibility contract JSON", false, contractPath || "missing substrate compatibility.json");
  } else {
    try {
      compatibilityContract = readJson(contractPath);
      add(checks, "compatibility contract JSON", true, contractPath);
    } catch (error) {
      add(checks, "compatibility contract JSON", false, error instanceof Error ? error.message : String(error));
    }
  }

  const substrateApiOk = compatibilityContract?.substrateApi === 1;
  const coreApiOk = compatibilityContract?.coreApi === 1;
  const adapterApiOk = compatibilityContract?.adapterApi === 1;
  add(checks, "substrate API compatibility", substrateApiOk, `expected 1, got ${String(compatibilityContract?.substrateApi)}`);
  add(checks, "core API compatibility", coreApiOk, `expected 1, got ${String(compatibilityContract?.coreApi)}`);
  add(checks, "adapter API compatibility", adapterApiOk, `expected 1, got ${String(compatibilityContract?.adapterApi)}`);
  compatibleApis = substrateApiOk && coreApiOk && adapterApiOk;

  const verdict = await substrateHealth(coreRoot);
  const healthy = verdict.ok === true && verdict.mode === "full" && verdict.substrateApi === 1;
  const detail = healthy
    ? "health.py proved a healthy, compatible substrate."
    : verdict.reason
      || (Array.isArray(verdict.degradedReasons) ? verdict.degradedReasons.join("; ") : "")
      || "health.py reported an unhealthy substrate.";
  runtimeHealth = {
    ok: healthy,
    state: healthy ? "healthy" : "unhealthy",
    detail,
    verdict,
  };
  add(checks, "substrate runtime health", healthy, detail);
}


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

const staticFailed = checks.filter((check) => !check.ok && check.name !== "substrate runtime health");
const mode: VerificationMode = !substrateConfigured
  ? "Base"
  : staticFailed.length === 0 && compatibleApis && runtimeHealth.ok === true
    ? "Full"
    : "degraded";
const result = {
  ok: staticFailed.length === 0 && mode !== "degraded",
  staticOk: staticFailed.length === 0,
  mode,
  adapterRoot,
  coreRoot,
  configPath,
  roomPath: roomArgument ? path.resolve(roomArgument) : null,
  substrateRoot,
  compatibilityPath: contractPath,
  compatibility: {
    ok: compatibleApis,
    expected: { substrateApi: 1, coreApi: 1, adapterApi: 1 },
    actual: compatibilityContract
      ? {
          substrateApi: compatibilityContract.substrateApi,
          coreApi: compatibilityContract.coreApi,
          adapterApi: compatibilityContract.adapterApi,
        }
      : null,
  },
  runtimeHealth,
  checks,
  next: mode === "Full"
    ? "Start a fresh OMP session from the room directory and call room_state."
    : mode === "Base"
      ? "Base House is statically verified; substrate memory is not configured."
      : "Fix substrate compatibility and runtime health, then rerun this verifier.",
};

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
