// Load canonical Solarisael House core modules.
// OMP stays an adapter: it normalizes OMP events, then calls the shared core.

import { pathToFileURL } from "node:url";
import { HOUSE_LEDGER_MODULE, HOUSE_MEMORY_MODULE } from "./constants.ts";

export async function loadHouseMemory() {
  return await import(pathToFileURL(HOUSE_MEMORY_MODULE).href);
}

export async function loadHouseLedger() {
  return await import(pathToFileURL(HOUSE_LEDGER_MODULE).href);
}
