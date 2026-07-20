import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { substrateHealth, windowsPathToWsl } from "../solarisael-house-proof/substrate.ts";

const tempRoots: string[] = [];
const substrateEnv = "SOLARISAEL_SUBSTRATE";
const pathEnv = "PATH";

function snapshotEnv() {
  return { substrate: process.env[substrateEnv], path: process.env[pathEnv] };
}

function restoreEnv(snapshot: { substrate?: string; path?: string }) {
  if (snapshot.substrate === undefined) delete process.env[substrateEnv];
  else process.env[substrateEnv] = snapshot.substrate;
  if (snapshot.path === undefined) delete process.env[pathEnv];
  else process.env[pathEnv] = snapshot.path;
}

afterEach(async () => {
  delete process.env[substrateEnv];
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeSubstrate(output: string, exitCode = 0) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "omp-health-substrate-"));
  tempRoots.push(dir);
  const script = [
    "import sys",
    `print(${JSON.stringify(output)})`,
    `sys.exit(${exitCode})`,
  ].join("\n");
  await writeFile(path.join(dir, "health.py"), `${script}\n`, "utf8");
  process.env[substrateEnv] = dir;
  return dir;
}

async function makeSleepingSubstrate(milliseconds: number) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "omp-health-timeout-"));
  tempRoots.push(dir);
  await writeFile(
    path.join(dir, "health.py"),
    ["import time", `time.sleep(${milliseconds / 1000})`, "print('{}')"].join("\n") + "\n",
    "utf8",
  );
  process.env[substrateEnv] = dir;
  return dir;
}

describe("optional substrate health", () => {
  test("keeps absent substrate in explicit Base mode", async () => {
    delete process.env[substrateEnv];
    const result = await substrateHealth("C:/unused");
    expect(result).toMatchObject({
      ok: null,
      configured: false,
      mode: "base",
      reason: "SOLARISAEL_SUBSTRATE is not configured",
    });
  });

  test("reports a configured substrate path that is missing", async () => {
    const dir = path.join(os.tmpdir(), `omp-health-missing-${Date.now()}-${Math.random()}`);
    process.env[substrateEnv] = dir;
    const result = await substrateHealth("C:/unused");
    expect(result).toMatchObject({
      ok: false,
      configured: true,
      mode: "degraded",
      reason: `configured substrate path is missing: ${dir}`,
    });
  });

  test("reports a configured substrate with no health script", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "omp-health-no-script-"));
    tempRoots.push(dir);
    process.env[substrateEnv] = dir;
    const result = await substrateHealth("C:/unused");
    expect(result).toMatchObject({
      ok: false,
      configured: true,
      mode: "degraded",
      reason: `configured substrate health script is missing: ${path.join(dir, "health.py")}`,
    });
  });

  test("claims Full mode only for a healthy compatible verdict", async () => {
    const dir = await makeSubstrate(JSON.stringify({ ok: true, mode: "full", substrateApi: 1, degradedReasons: [] }));
    const result = await substrateHealth("C:/unused");
    expect(result).toMatchObject({ ok: true, configured: true, mode: "full", substrateApi: 1, path: dir, reason: null });
  });

  test("preserves an explicit degraded health reason", async () => {
    await makeSubstrate(JSON.stringify({ ok: false, mode: "degraded", substrateApi: 1, degradedReasons: ["database is unavailable"] }), 1);
    const result = await substrateHealth("C:/unused");
    expect(result).toMatchObject({ ok: false, configured: true, mode: "degraded", reason: "database is unavailable" });
    expect(result.degradedReasons).toEqual(["database is unavailable"]);
  });

  test("reports malformed JSON as degraded", async () => {
    await makeSubstrate("not json");
    const result = await substrateHealth("C:/unused");
    expect(result.mode).toBe("degraded");
    expect(result.reason).toContain("health.py returned malformed JSON:");
  });

  test("reports timeout as degraded without blocking Base behavior", async () => {
    await makeSleepingSubstrate(250);
    const result = await substrateHealth("C:/unused", 20);
    expect(result).toMatchObject({ ok: false, configured: true, mode: "degraded", reason: "health.py timed out" });
  });

  test("reports a WSL launch failure as degraded", async () => {
    const snapshot = snapshotEnv();
    try {
      const dir = await makeSubstrate(JSON.stringify({ ok: true, mode: "full", substrateApi: 1 }));
      process.env[pathEnv] = path.join(dir, "missing-bin");
      const result = await substrateHealth("C:/unused", 100);
      expect(result.mode).toBe("degraded");
      expect(result.reason).toContain("health.py launch failed:");
    } finally {
      restoreEnv(snapshot);
    }
  });

  test("reports substrate API mismatch instead of claiming Full mode", async () => {
    await makeSubstrate(JSON.stringify({ ok: true, mode: "full", substrateApi: 2, degradedReasons: [] }));
    const result = await substrateHealth("C:/unused");
    expect(result).toMatchObject({ ok: false, configured: true, mode: "degraded" });
    expect(result.reason).toContain("substrate API mismatch");
  });

  test("translates configured Windows paths at the WSL boundary", () => {
    expect(windowsPathToWsl("C:\\Projects\\substrate\\health.py")).toBe("/mnt/c/Projects/substrate/health.py");
  });
});
