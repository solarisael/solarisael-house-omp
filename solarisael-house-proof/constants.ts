// OMP Solarisael House constants.
// Values only: paths, timeouts, filenames, and stable runtime defaults.

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HOUSE_CORE_ROOT = process.env.SOLARISAEL_HOUSE_CORE
  ? path.resolve(process.env.SOLARISAEL_HOUSE_CORE)
  : fileURLToPath(new URL("../../solarisael-house/", import.meta.url));
export const HOUSE_MEMORY_MODULE = path.join(HOUSE_CORE_ROOT, "src", "memory.ts");
export const HOUSE_LEDGER_MODULE = path.join(HOUSE_CORE_ROOT, "src", "ledger.ts");
export const HOUSE_ROUTING_MODULE = path.join(HOUSE_CORE_ROOT, "src", "routing.ts");
export const HOUSE_QUERY_ROUTING_MODULE = path.join(HOUSE_CORE_ROOT, "src", "query-routing.ts");
export const POSTGRES_SOURCE_SCRIPT = path.join(HOUSE_CORE_ROOT, "src", "postgres-memory-source.py");
export const CODING_LESSONS_SCRIPT = path.join(HOUSE_CORE_ROOT, "src", "coding-lessons-by-shape.py");

export const OBSIDIAN_ROOT = process.env.SOLARISAEL_VAULT_ROOT
  ? path.resolve(process.env.SOLARISAEL_VAULT_ROOT)
  : path.join(os.homedir(), "Solarisael");
export const DIAGNOSTIC_TIMEOUT_MS = 8000;
export const WRITE_TIMEOUT_MS = 90000;
export const OMP_SESSION_ID = "omp";
export const TRANSCRIPT_DEBUG_LOG = "solarisael-house-transcript-debug.jsonl";
export const HOUSE_STATE_FILENAME = "solarisael-house-state.json";
