import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const adapterRoot = path.resolve(import.meta.dir, "..");
const verifier = path.join(adapterRoot, "verify-install.ts");
const temporary: string[] = [];

async function runVerifier(args: string[], env: Record<string, string | undefined>) {
  const child = Bun.spawn({
    cmd: [process.execPath, verifier, ...args],
    cwd: adapterRoot,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  return { exitCode: await child.exited, result: JSON.parse(stdout) };
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe("verify-install diagnostics", () => {
  test("reports missing config and invalid Rust selection with navigable redacted diagnostics", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "omp-verify-diagnostics-"));
    temporary.push(root);
    const missingConfig = path.join(root, "missing-config.yml");
    const { exitCode, result } = await runVerifier(["--config", missingConfig], {
      SOLARISAEL_SUBSTRATE: "",
      SOLARISAEL_HOUSE_RUST: "postgres://user:password@private.example/rust?token=sensitive",
    });

    expect(exitCode).not.toBe(0);
    const rust = result.diagnostics.find((entry: any) => entry.observed.check === "Rust executable selection");
    const config = result.diagnostics.find((entry: any) => entry.observed.check === "OMP config");
    expect(rust).toMatchObject({
      category: "configuration",
      stage: "configuration_load",
      owner: { path: "verify-install.ts", symbol: "main" },
      execution: { request_dispatched: false, write_outcome: "not_started", retry: "after_change" },
    });
    expect(rust.next_checks).toHaveLength(2);
    expect(JSON.stringify(rust)).not.toContain("password");
    expect(JSON.stringify(rust)).not.toContain("sensitive");
    expect(config.targets).toContainEqual({ kind: "file", path: missingConfig });
  });

  test("reports missing compatibility schema with expected and observed values", async () => {
    const substrate = await mkdtemp(path.join(os.tmpdir(), "omp-verify-schema-"));
    temporary.push(substrate);
    const { result } = await runVerifier(["--substrate", substrate], {
      SOLARISAEL_SUBSTRATE: substrate,
    });

    const schema = result.diagnostics.find((entry: any) => entry.observed.check === "compatibility schema");
    expect(schema).toMatchObject({
      category: "protocol",
      expected: { check: "compatibility schema", ok: true },
      observed: { check: "compatibility schema", ok: false },
      targets: [{ kind: "file", path: path.join(substrate, "compatibility.json") }],
    });
  });
});
