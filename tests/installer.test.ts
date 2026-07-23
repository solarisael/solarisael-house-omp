import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const rootDir = path.resolve(import.meta.dir, "..");
const installer = path.join(rootDir, "installer.ts");
const roots: string[] = [];
const run = (args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
  const child = spawn(process.execPath, [installer, ...args], { windowsHide: true }); let stdout = "", stderr = "";
  child.stdout.on("data", (x) => stdout += x); child.stderr.on("data", (x) => stderr += x); child.on("error", reject); child.on("exit", (code) => resolve({ code: code ?? -1, stdout, stderr }));
});
async function fixture(verifier = "console.log(JSON.stringify({ok:true}));\n") {
  const root = await mkdtemp(path.join(os.tmpdir(), "house-installer-test-")); roots.push(root); const tree = path.join(root, "tree");
  for (const d of ["solarisael-house", "solarisael-house-omp", "starter-room/example"]) await mkdir(path.join(tree, d), { recursive: true });
  await writeFile(path.join(tree, "solarisael-house/index.ts"), "export const CORE_API_VERSION=1;\n");
  await writeFile(path.join(tree, "solarisael-house-omp/index.ts"), "export const ADAPTER_API_VERSION=1;\n");
  await writeFile(path.join(tree, "solarisael-house-omp/discovery.ts"), "export {};\n"); await writeFile(path.join(tree, "solarisael-house-omp/hygiene.ts"), "export {};\n"); await writeFile(path.join(tree, "solarisael-house-omp/verify-install.ts"), verifier);
  await writeFile(path.join(tree, "starter-room/example/.solarisael-room.json"), JSON.stringify({ version: 1, room: "example", trueName: "Mica", operator: "Example" })); await writeFile(path.join(tree, "starter-room/example/active_spirit.md"), "# Active Spirit: Mica\nAgent: Mica | Operator: Example\n# SPIRIT: Mica\n"); await writeFile(path.join(tree, "starter-room/example/AGENTS.md"), "@active_spirit.md\n@room_summary.md\n");
  const zip = path.join(root, "bundle.zip"); const tar = spawn("tar", ["-a", "-c", "-f", zip, "-C", tree, "."], { windowsHide: true }); await new Promise<void>((resolve, reject) => { tar.on("error", reject); tar.on("exit", (c) => c === 0 ? resolve() : reject(new Error("tar failed"))); }); return { root, zip };
}
afterEach(async () => { await Promise.all(roots.splice(0).map((x) => rm(x, { recursive: true, force: true }))); });

describe("installer", () => {
  test("rejects unsafe room and missing required bundle without mutation", async () => { const { root, zip } = await fixture(); const target = path.join(root, "new target"); const result = await run(["--bundle", zip, "--target", target, "--room", "../escape", "--mode", "base", "--dry-run"]); expect(result.code).not.toBe(0); expect(await stat(target).catch(() => null)).toBeNull(); });
  test("dry-run validates a bundle while leaving target absent", async () => { const { root, zip } = await fixture(); const target = path.join(root, "target with spaces"); const result = await run(["--bundle", zip, "--target", target, "--room", "demo-room", "--mode", "base", "--dry-run"]); expect(result.code).toBe(0); expect(JSON.parse(result.stdout).dryRun).toBe(true); expect(await stat(target).catch(() => null)).toBeNull(); });
  test("existing target refuses without force", async () => { const { root, zip } = await fixture(); const target = path.join(root, "existing"); await mkdir(target); await writeFile(path.join(target, "keep"), "yes"); const result = await run(["--bundle", zip, "--target", target, "--room", "demo", "--mode", "base"]); expect(result.code).not.toBe(0); expect(await readFile(path.join(target, "keep"), "utf8")).toBe("yes"); });
  test("writes actual config paths while preserving unrelated config", async () => {
    const { root, zip } = await fixture(); const target = path.join(root, "install"); const config = path.join(root, "omp-config.yml");
    await writeFile(config, "model: user-choice\nextensions:\n  - keep-extension.ts\n");
    const result = await run(["--bundle", zip, "--target", target, "--room", "demo", "--mode", "base", "--config", config]);
    expect(result.code).toBe(0);
    const written = await readFile(config, "utf8");
    expect(written).toContain("model: user-choice"); expect(written).toContain("keep-extension.ts");
    expect(written).toContain(path.join(target, "solarisael-house-omp", "index.ts").replaceAll("\\", "/"));
    expect(written).not.toContain("solarisael-house-omp-install");
  });
  test("full mode refuses without substrate configuration", async () => {
    const { root, zip } = await fixture(); const target = path.join(root, "full");
    const result = await run(["--bundle", zip, "--target", target, "--room", "demo", "--mode", "full", "--config", path.join(root, "config.yml")]);
    expect(result.code).not.toBe(0); expect(result.stderr).toContain("substrate");
    expect(await stat(target).catch(() => null)).toBeNull();
  });
  test("force preserves existing rooms and user files", async () => {
    const { root, zip } = await fixture(); const target = path.join(root, "existing"); const config = path.join(root, "config.yml");
    await mkdir(path.join(target, "rooms", "old-room"), { recursive: true }); await writeFile(path.join(target, "rooms", "old-room", "notes.md"), "keep me");
    await writeFile(path.join(target, "operator.txt"), "keep user file");
    const result = await run(["--bundle", zip, "--target", target, "--room", "demo", "--mode", "base", "--force", "--config", config]);
    expect(result.code).toBe(0); expect(await readFile(path.join(target, "rooms", "old-room", "notes.md"), "utf8")).toBe("keep me"); expect(await readFile(path.join(target, "operator.txt"), "utf8")).toBe("keep user file");
  });
  test("verification failure rolls back target and config", async () => {
    const { root, zip } = await fixture("process.exit(1);\n"); const target = path.join(root, "existing"); const config = path.join(root, "config.yml");
    await mkdir(target); await writeFile(path.join(target, "sentinel"), "original"); await writeFile(config, "extensions:\n  - original.ts\n");
    const result = await run(["--bundle", zip, "--target", target, "--room", "demo", "--mode", "base", "--force", "--config", config]);
    expect(result.code).not.toBe(0); expect(await readFile(path.join(target, "sentinel"), "utf8")).toBe("original"); expect(await readFile(config, "utf8")).toBe("extensions:\n  - original.ts\n");
  });
  test("stale config paths are not retained", async () => {
    const { root, zip } = await fixture(); const target = path.join(root, "new-target"); const config = path.join(root, "config.yml");
    await writeFile(config, "extensions:\n  - C:/old/stage/solarisael-house-omp/index.ts\n");
    const result = await run(["--bundle", zip, "--target", target, "--room", "demo", "--mode", "base", "--config", config]);
    expect(result.code).toBe(0); const written = await readFile(config, "utf8"); expect(written).not.toContain("C:/old/stage");
  });
  test("reports cleanup warnings without failing install", async () => {
    const { root, zip } = await fixture(); const target = path.join(root, "target"); const config = path.join(root, "config.yml");
    await writeFile(config, "extensions:\n  - keep.ts\n");
    const result = await run(["--bundle", zip, "--target", target, "--room", "demo", "--mode", "base", "--config", config]);
    expect(result.code).toBe(0); expect(JSON.parse(result.stdout).ok).toBe(true);
  });
  test("installer source compiles for the current platform", async () => { const result = await new Promise<{ code: number }>((resolve, reject) => { const child = spawn("bun", ["build", "--compile", installer, "--outfile", path.join(os.tmpdir(), `house-installer-${Date.now()}.exe`)], { windowsHide: true }); child.on("error", reject); child.on("exit", (code) => resolve({ code: code ?? -1 })); }); expect(result.code).toBe(0); });
});
