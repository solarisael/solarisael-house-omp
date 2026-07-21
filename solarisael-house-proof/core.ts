// Load the canonical Solarisael House package root.
// OMP is an adapter: it normalizes OMP events, then calls the versioned core.

import { pathToFileURL } from "node:url";
import path from "node:path";
import { HOUSE_CORE_ROOT } from "./constants.ts";

const CORE_API_VERSION = 1;
const coreEntry = path.join(HOUSE_CORE_ROOT, "index.ts");
let coreModulePromise;

export async function loadHouseCore() {
  if (!coreModulePromise) {
    coreModulePromise = import(pathToFileURL(coreEntry).href);
  }
  const core = await coreModulePromise;
  if (core.CORE_API_VERSION !== CORE_API_VERSION) {
    throw new Error(`Unsupported Solarisael House core API: expected ${CORE_API_VERSION}, got ${String(core.CORE_API_VERSION)}`);
  }
  for (const name of ["runRecallQuery", "runAnamnesisQuery", "logUserTurn", "logAssistantTurn"]) {
    if (typeof core[name] !== "function") {
      throw new Error(`Solarisael House core API is missing ${name}`);
    }
  }
  return core;
}

export async function loadHouseMemory() {
  const core = await loadHouseCore();
  return {
    runRecallQuery: core.runRecallQuery,
    runAnamnesisQuery: core.runAnamnesisQuery,
  };
}

export async function loadHouseLedger() {
  const core = await loadHouseCore();
  return {
    logUserTurn: core.logUserTurn,
    logAssistantTurn: core.logAssistantTurn,
  };
}

export async function loadHouseRouting() {
  return await loadHouseCore();
}

export async function loadHouseQueryRouting() {
  return await loadHouseCore();
}
