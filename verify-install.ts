import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { currentRustPlatform, discoverRustExecutable, rustBinaryName } from "./discovery.ts";
import { substrateHealth } from "./solarisael-house-proof/substrate.ts";

type Diagnostic = {
  category: string;
  stage: string;
  operation: string;
  owner: { component: string; path: string; symbol: string };
  expected: Record<string, unknown>;
  observed: Record<string, unknown>;
  evidence: Array<Record<string, unknown>>;
  targets: Array<Record<string, unknown>>;
  next_checks: Array<Record<string, unknown>>;
  execution: { request_dispatched: boolean; write_outcome: "not_started"; retry: "safe_now" | "after_change" };
};

type Check = {
  name: string;
  ok: boolean;
  detail: string;
  diagnostic?: Diagnostic;
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

function absolutePath(value: string) {
  const source = String(value || "").trim();
  return path.posix.isAbsolute(source)
    || path.win32.isAbsolute(source)
    || /^[A-Za-z]:[\\/]/.test(source)
    || /^\\\\/.test(source);
}

function validRoomKey(value: unknown) {
  return typeof value === "string"
    && value !== "house"
    && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function validDisplayName(value: unknown) {
  return typeof value === "string"
    && value.trim().length > 0
    && value.trim().length <= 80
    && !/[\r\n|]/.test(value);
}
function add(checks: Check[], name: string, ok: boolean, detail: string, diagnostic?: Diagnostic) {
  checks.push({ name, ok, detail, diagnostic });
}

function redacted(value: unknown) {
  return String(value ?? "")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, "$1[redacted]@")
    .replace(/\b[\w.-]+:[^@\\/\s]+@/g, "[redacted]@")
    .replace(/\b(token|password|secret|api[_-]?key|authorization)\s*[:=]\s*\S+/gi, "$1: [redacted]");
}

function checkDiagnostic(check: Check): Diagnostic {
  const lower = check.name.toLowerCase();
  const category = /rust/.test(lower) ? "configuration"
    : /compatibility|api|schema/.test(lower) ? "protocol"
    : /substrate|config/.test(lower) ? "configuration"
    : "operation";
  const target = /rust/.test(lower)
    ? { kind: "environment", name: "SOLARISAEL_HOUSE_RUST" }
    : /config/.test(lower)
      ? { kind: "file", path: configPath }
      : /compatibility|api|schema/.test(lower)
        ? { kind: "file", path: contractPath || "compatibility.json" }
        : { kind: "source", path: "verify-install.ts", symbol: check.name };
  return {
    category,
    stage: category === "protocol" ? "validation" : "configuration_load",
    operation: "verify_install",
    owner: { component: "solarisael-house-omp", path: "verify-install.ts", symbol: "main" },
    expected: { check: check.name, ok: true },
    observed: { check: check.name, ok: false, detail: redacted(check.detail) },
    evidence: [{ source: "verify-install.ts", check: check.name, detail: redacted(check.detail) }],
    targets: [target],
    next_checks: [
      { action: category === "protocol" ? "validate_compatibility_contract" : "inspect_configuration", target },
      { action: "rerun_verify_install", target: { path: "verify-install.ts" } },
    ],
    execution: { request_dispatched: false, write_outcome: "not_started", retry: "after_change" },
  };
}

function readJson(filePath: string): CompatibilityContract {
  return JSON.parse(readFileSync(filePath, "utf8")) as CompatibilityContract;
}

function verifyRustBundle(checks: Check[]): void {
  const rustRequested = Boolean(String(process.env.SOLARISAEL_HOUSE_RUST || "").trim())
    || process.env.SOLARISAEL_HOUSE_RUST_AUTO === "1";
  if (rustRequested) {
    try {
      const executable = discoverRustExecutable({ moduleDir: adapterRoot });
      add(checks, "Rust executable selection", Boolean(executable), executable || "no executable was found for the requested Rust selection");
    } catch (error) {
      add(checks, "Rust executable selection", false, error instanceof Error ? error.message : String(error));
    }
  }
  const manifestPath = path.join(adapterRoot, "rust-manifest.json");
  if (!existsSync(manifestPath)) return;
  let manifest: any;
  try { manifest = readJson(manifestPath); } catch (error) {
    add(checks, "Rust manifest", false, `invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const platform = currentRustPlatform();
  const artifact = Array.isArray(manifest.artifacts) ? manifest.artifacts.find((entry: any) => entry?.platform === platform) : null;
  add(checks, "Rust manifest platform", Boolean(artifact), platform ? `expected ${platform}` : "unsupported host platform");
  if (!artifact || typeof artifact.path !== "string") return;
  const artifactPath = path.resolve(adapterRoot, artifact.path);
  const insideAdapter = artifactPath === adapterRoot || artifactPath.startsWith(`${adapterRoot}${path.sep}`);
  add(checks, "Rust artifact path", insideAdapter, artifactPath);
  if (!insideAdapter || !existsSync(artifactPath)) {
    add(checks, "Rust artifact file", false, artifactPath);
    return;
  }
  try {
    const details = statSync(artifactPath);
    add(checks, "Rust artifact regular file", details.isFile(), artifactPath);
    if (!details.isFile()) return;
    add(checks, "Rust artifact permissions", process.platform === "win32" || (details.mode & 0o111) !== 0, "must be executable");
    const hash = createHash("sha256").update(readFileSync(artifactPath)).digest("hex");
    add(checks, "Rust artifact SHA256", hash === artifact.sha256, `expected ${artifact.sha256}; got ${hash}`);
    add(checks, "Rust artifact size", details.size === artifact.size, `expected ${artifact.size}; got ${details.size}`);
    add(checks, "Rust artifact name", path.basename(artifactPath) === rustBinaryName(platform), path.basename(artifactPath));
  } catch (error) {
    add(checks, "Rust artifact readable", false, error instanceof Error ? error.message : String(error));
  }
}
function verifyPortableManifest(checks: Check[]): void {
  const manifestPath = path.join(adapterRoot, "package-manifest.json");
  if (!existsSync(manifestPath)) return;
  let manifest: any;
  try { manifest = readJson(manifestPath); } catch (error) { add(checks, "package manifest", false, error instanceof Error ? error.message : String(error)); return; }
  const required = ["discovery.ts", "rust-transport.ts", "gui-server.ts", "installer.ts", "gui/index.html", "gui/app.js", "gui/style.css"];
  add(checks, "GUI and installer manifest", Array.isArray(manifest.artifacts), "package-manifest.json");
  for (const relative of required) {
    const artifact = manifest.artifacts?.find((entry: any) => entry?.path === `solarisael-house-omp/${relative}`);
    const file = path.join(adapterRoot, relative);
    if (!artifact || !existsSync(file)) { add(checks, `portable artifact ${relative}`, false, file); continue; }
    const details = statSync(file);
    const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
    add(checks, `portable artifact ${relative}`, details.isFile() && details.size === artifact.size && hash === artifact.sha256, file);
  }
  const installer = String(manifest.installer || "");
  const installerPath = path.join(adapterRoot, installer);
  const details = existsSync(installerPath) ? statSync(installerPath) : null;
  add(checks, "compiled installer", Boolean(details?.isFile()), installerPath);
  if (details?.isFile()) {
    const artifact = manifest.artifacts.find((entry: any) => entry?.path === `solarisael-house-omp/${installer}`);
    const hash = createHash("sha256").update(readFileSync(installerPath)).digest("hex");
    add(checks, "compiled installer SHA256", Boolean(artifact && hash === artifact.sha256 && details.size === artifact.size), installerPath);
    add(checks, "compiled installer platform name", path.basename(installerPath) === (process.platform === "win32" ? "install.exe" : "install"), path.basename(installerPath));
  }
}


const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const adapterRoot = existsSync(path.join(scriptRoot, "index.ts"))
  ? scriptRoot
  : path.join(scriptRoot, "solarisael-house-omp");
const coreRoot = process.env.SOLARISAEL_HOUSE_CORE
  ? path.resolve(process.env.SOLARISAEL_HOUSE_CORE)
  : path.resolve(path.dirname(adapterRoot), "the-athanor");
const roomArgument = argument("--room");
const configPath = path.resolve(argument("--config") || path.join(os.homedir(), ".omp", "agent", "config.yml"));
const substrateArgument = argument("--substrate");
const substrateSetting = String(substrateArgument || process.env.SOLARISAEL_SUBSTRATE || "").trim() || null;
const substrateConfigured = Boolean(substrateSetting);
const substrateAbsolute = !substrateConfigured || absolutePath(substrateSetting as string);
const substrateRoot = substrateConfigured && substrateAbsolute ? path.resolve(substrateSetting as string) : null;
const substratePathError = substrateConfigured && !substrateAbsolute
  ? `SOLARISAEL_SUBSTRATE must be an absolute path when configured (got ${substrateSetting})`
  : null;
const contractPath = substrateRoot ? path.join(substrateRoot, "compatibility.json") : null;
if (substrateConfigured) process.env.SOLARISAEL_SUBSTRATE = substrateSetting as string;
const checks: Check[] = [];
let compatibilityContract: CompatibilityContract | null = null;
let compatibleApis = false;
let adapterApiVersion: unknown = null;
let coreApiVersion: unknown = null;
let rootImportError: string | null = null;

try {
  const adapterPackage = await import(pathToFileURL(path.join(adapterRoot, "index.ts")).href);
  adapterApiVersion = adapterPackage.ADAPTER_API_VERSION;
} catch (error) {
  rootImportError = `adapter root import failed: ${error instanceof Error ? error.message : String(error)}`;
}
try {
  const corePackage = await import(pathToFileURL(path.join(coreRoot, "index.ts")).href);
  coreApiVersion = corePackage.CORE_API_VERSION;
} catch (error) {
  rootImportError = rootImportError
    ? `${rootImportError}; core root import failed: ${error instanceof Error ? error.message : String(error)}`
    : `core root import failed: ${error instanceof Error ? error.message : String(error)}`;
}

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

add(checks, "core package", existsSync(path.join(coreRoot, "index.ts")), path.join(coreRoot, "index.ts"));
add(checks, "core API export", coreApiVersion === 1, rootImportError || `expected 1, got ${String(coreApiVersion)}`);
add(checks, "OMP adapter entrypoint", existsSync(path.join(adapterRoot, "index.ts")), path.join(adapterRoot, "index.ts"));
add(checks, "adapter API export", adapterApiVersion === 1, rootImportError || `expected 1, got ${String(adapterApiVersion)}`);
add(checks, "OMP hygiene extension", existsSync(path.join(adapterRoot, "hygiene.ts")), path.join(adapterRoot, "hygiene.ts"));

if (substrateConfigured) {
  add(checks, "substrate path absolute", !substratePathError, substratePathError || String(substrateRoot));
  if (substrateRoot) add(checks, "substrate directory", existsSync(substrateRoot), substrateRoot);
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
  const schemaOk = compatibilityContract?.format === 1 && compatibilityContract?.schemaVersion === 1;
  add(
    checks,
    "compatibility schema",
    schemaOk,
    `expected format=1 schemaVersion=1; got format=${String(compatibilityContract?.format)} schemaVersion=${String(compatibilityContract?.schemaVersion)}`,
  );

  const substrateApiOk = compatibilityContract?.substrateApi === 1;
  const coreApiOk = coreApiVersion === 1 && compatibilityContract?.coreApi === coreApiVersion;
  const adapterApiOk = adapterApiVersion === 1 && compatibilityContract?.adapterApi === adapterApiVersion;
  add(checks, "substrate API compatibility", substrateApiOk, `expected 1, got ${String(compatibilityContract?.substrateApi)}`);
  add(checks, "core API compatibility", coreApiOk, `expected ${String(coreApiVersion)}, got ${String(compatibilityContract?.coreApi)}`);
  add(checks, "adapter API compatibility", adapterApiOk, `expected ${String(adapterApiVersion)}, got ${String(compatibilityContract?.adapterApi)}`);
  compatibleApis = schemaOk && substrateApiOk && coreApiOk && adapterApiOk;

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
    add(checks, "room key format", validRoomKey(roomKey), roomKey || "missing marker.room");
    add(checks, "room key reserved", roomKey !== "house", roomKey === "house" ? "room key 'house' is reserved for the House substrate" : "room key is available");
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
verifyRustBundle(checks);
verifyPortableManifest(checks);

const staticFailed = checks.filter((check) => !check.ok && check.name !== "substrate runtime health");
const diagnostics: Diagnostic[] = [
  ...checks.filter((check) => !check.ok).map((check) => check.diagnostic || checkDiagnostic(check)),
  ...(Array.isArray(runtimeHealth.verdict?.diagnostics) ? runtimeHealth.verdict.diagnostics as Diagnostic[] : []),
];
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
  diagnostics,
  checks,
  next: mode === "Full"
    ? "Start a fresh OMP session from the room directory and call room_state."
    : mode === "Base"
      ? "Base House is statically verified; substrate memory is not configured."
      : "Fix substrate compatibility and runtime health, then rerun this verifier.",
};

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
