import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { HARNESS_DESCRIPTORS, selectHarnesses, type HarnessId } from "./harnesses.ts";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

type Mode = "base" | "full";
type Options = { bundle: string; target: string; room: string; mode: Mode; force: boolean; dryRun: boolean; update: boolean; config: string; substrate?: string; harnesses: HarnessId[] };
type Result = { ok: boolean; target: string; room?: string; harnesses?: HarnessId[]; dryRun?: boolean; updated?: boolean; warning?: string; error?: string };
const usage = (): never => { throw new Error("Usage: installer.ts --bundle ZIP --target DIR --room ROOM --mode base|full [--harness omp] [--config ABSOLUTE_PATH] [--substrate PATH] [--force] [--update] [--dry-run], or --list-harnesses"); };
const isAbsolute = (v: string) => path.isAbsolute(v) || /^[A-Za-z]:[\\/]/.test(v) || /^\\\\/.test(v);
function parseArgs(argv: string[]): Options {
  const values = new Map<string, string>();
  const harnessValues: string[] = [];
  let force = false;
  let dryRun = false;
  let update = false;
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === "--force") { force = true; continue; }
    if (argument === "--dry-run") { dryRun = true; continue; }
    if (argument === "--update") { update = true; continue; }
    if (!["--bundle", "--target", "--room", "--mode", "--config", "--substrate", "--harness"].includes(argument)) usage();
    const value = argv[++i];
    if (!value || value.startsWith("--")) usage();
    if (argument === "--harness") harnessValues.push(value);
    else values.set(argument, value);
  }
  const bundle = values.get("--bundle");
  const target = values.get("--target");
  const room = values.get("--room");
  const mode = values.get("--mode") as Mode;
  const config = values.get("--config") || path.join(os.homedir(), ".omp", "agent", "config.yml");
  if (!bundle || !target || !room || (mode !== "base" && mode !== "full")) usage();
  if (!isAbsolute(target) || !isAbsolute(config)) throw new Error("--target and --config must be absolute paths");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(room) || room === "house") throw new Error("--room must be a safe non-reserved slug");
  return {
    bundle: path.resolve(bundle),
    target: path.resolve(target),
    room,
    mode,
    force,
    dryRun,
    update,
    config: path.resolve(config),
    substrate: values.get("--substrate"),
    harnesses: selectHarnesses(harnessValues),
  };
}
function exec(command: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> { return new Promise((resolve, reject) => { const c = spawn(command, args, { cwd, env, windowsHide: true }); let stdout = "", stderr = ""; c.stdout?.on("data", d => stdout += d); c.stderr?.on("data", d => stderr += d); c.on("error", reject); c.on("exit", code => resolve({ code: code ?? -1, stdout, stderr })); }); }
function safeEntry(entry: string) { const n = entry.replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+$/, ""); return n === "" || (n !== "." && !n.startsWith("/") && !/^[A-Za-z]:/.test(n) && !n.split("/").includes("..")); }
async function archiveEntries(bundle: string) { const r = await exec("tar", ["-tf", bundle]); if (r.code) throw new Error(`unable to read bundle: ${r.stderr || r.stdout}`); const e = r.stdout.split(/\r?\n/).map(x => x.trim()).filter(Boolean); for (const x of e) if (!safeEntry(x)) throw new Error(`unsafe archive entry: ${x}`); return e.map(x => x.replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+$/, "")).filter(Boolean); }
const required = ["solarisael-house/index.ts", "solarisael-house-omp/index.ts", "solarisael-house-omp/discovery.ts", "solarisael-house-omp/harnesses.ts", "solarisael-house-omp/hygiene.ts", "solarisael-house-omp/verify-install.ts", "solarisael-house-omp/package-manifest.json", "solarisael-house-omp/rust-manifest.json", "starter-room/example/.solarisael-room.json", "starter-room/example/active_spirit.md", "starter-room/example/AGENTS.md"];
async function noSymlinks(root: string) { const walk = async (d: string): Promise<void> => { for (const x of await readdir(d, { withFileTypes: true })) { const f = path.join(d, x.name), i = await lstat(f); if (i.isSymbolicLink()) throw new Error(`symlink archive entry refused: ${path.relative(root, f)}`); if (i.isDirectory()) await walk(f); } }; await walk(root); }
async function mergeMissing(from: string, into: string) { for (const x of await readdir(from, { withFileTypes: true })) { const s = path.join(from, x.name), d = path.join(into, x.name); if (await lstat(d).catch(() => null)) { if (x.isDirectory() && (await lstat(d)).isDirectory()) await mergeMissing(s, d); } else await cp(s, d, { recursive: x.isDirectory() }); } }
async function configure(stage: string, room: string) {
  const roomDir = path.join(stage, "rooms", room);
  await mkdir(path.dirname(roomDir), { recursive: true });
  await cp(path.join(stage, "starter-room", "example"), roomDir, { recursive: true, force: true });
  const markerPath = path.join(roomDir, ".solarisael-room.json");
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  marker.room = room;
  marker.trueName = room;
  marker.operator = process.env.USERNAME || process.env.USER || "Operator";
  await writeFile(markerPath, JSON.stringify(marker, null, 2) + "\n");
  const spiritPath = path.join(roomDir, "active_spirit.md");
  let spirit = (await readFile(spiritPath, "utf8")).replaceAll("\r\n", "\n");
  spirit = spirit
    .replace(/^# Active Spirit:.*$/m, `# Active Spirit: ${marker.trueName}`)
    .replace(/^Agent:.*$/m, `Agent: ${marker.trueName} | Operator: ${marker.operator}`)
    .replace(/^# SPIRIT:.*$/m, `# SPIRIT: ${marker.trueName}`);
  await writeFile(spiritPath, spirit);
  return roomDir;
}
function wireConfig(text: string, target: string) { const paths = [path.join(target, "solarisael-house-omp", "index.ts"), path.join(target, "solarisael-house-omp", "hygiene.ts")].map(x => x.replaceAll("\\", "/")); const lines = (text ? text.split(/\r?\n/) : []).filter(x => !/solarisael-house-omp[\\/](?:index|hygiene)\.ts/.test(x)); const existing = new Set(lines.map(x => x.trim().replace(/^[- ]+/, ""))); if (!lines.some(x => /^extensions:\s*$/.test(x.trim()))) lines.push("extensions:"); let idx = lines.findIndex(x => /^extensions:\s*$/.test(x.trim())) + 1; for (const p of paths) if (!existing.has(p)) lines.splice(idx++, 0, `  - ${p}`); return lines.join("\n").replace(/\n*$/, "\n"); }
async function main(): Promise<Result> {
  const options = parseArgs(process.argv.slice(2));
  const exists = Boolean(await lstat(options.target).catch(() => null));
  if (options.update && !exists) throw new Error("update target does not exist");
  if (exists && !options.force && !options.update) {
    throw new Error("target already exists; pass --force to replace it or --update to preserve it");
  }
  const bundleInfo = await lstat(options.bundle).catch(() => null);
  if (!bundleInfo?.isFile()) throw new Error("bundle must be a regular file");
  const entries = await archiveEntries(options.bundle);
  for (const entry of required) {
    if (!entries.includes(entry)) throw new Error(`bundle missing required file: ${entry}`);
  }
  if (!options.dryRun) await mkdir(path.dirname(options.target), { recursive: true });
  const temp = await mkdtemp(path.join(options.dryRun ? os.tmpdir() : path.dirname(options.target), ".solarisael-house-install-"));
  const stage = path.join(temp, "install");
  let targetBackup: string | undefined;
  let configBackup: string | undefined;
  let targetCommitted = false;
  let configCommitted = false;
  let warning: string | undefined;
  try {
    await mkdir(stage, { recursive: true });
    const extraction = await exec("tar", ["-xf", options.bundle, "-C", stage]);
    if (extraction.code) throw new Error(`bundle extraction failed: ${extraction.stderr || extraction.stdout}`);
    await noSymlinks(stage);
    if (exists) await mergeMissing(options.target, stage);
    if (options.update) {
      const marker = path.join(stage, "rooms", options.room, ".solarisael-room.json");
      if (!(await lstat(marker).catch(() => null))?.isFile()) {
        throw new Error(`update room is missing its marker: ${marker}`);
      }
    } else {
      await configure(stage, options.room);
    }
    if (options.mode === "full" && !options.substrate) {
      throw new Error("full mode requires a substrate path/config");
    }
    const existingConfig = await readFile(options.config, "utf8").catch(() => "");
    const ompSelected = options.harnesses.includes("omp");
    const canonicalStage = await realpath(stage);
    const canonicalTarget = path.join(await realpath(path.dirname(options.target)), path.basename(options.target));
    const proposed = ompSelected ? wireConfig(existingConfig, canonicalTarget) : existingConfig;
    const proposedConfig = path.join(temp, "config.yml");
    await writeFile(proposedConfig, wireConfig(existingConfig, canonicalStage));
    const bun = /(?:^|[\\/])bun(?:\.exe)?$/i.test(process.execPath) ? process.execPath : "bun";
    const verifyArgs = [path.join(stage, "solarisael-house-omp", "verify-install.ts"), "--room", path.join(stage, "rooms", options.room), "--config", proposedConfig, "--require-manifest"];
    if (options.substrate) verifyArgs.push("--substrate", options.substrate);
    const verification = await exec(bun, verifyArgs, stage, { ...process.env, SOLARISAEL_HOUSE_CORE: path.join(stage, "solarisael-house") });
    if (verification.code) throw new Error(`bundle verification failed: ${verification.stdout || verification.stderr}`);
    if (options.mode === "full") {
      const result = JSON.parse(verification.stdout.trim());
      if (result.mode !== "Full") throw new Error("Full verification refused: verifier mode is not exactly Full");
    }
    if (options.dryRun) {
      return { ok: true, target: options.target, room: options.room, harnesses: options.harnesses, dryRun: true, updated: options.update };
    }
    if (exists) {
      targetBackup = `${options.target}.backup-${Date.now()}`;
      await rename(options.target, targetBackup);
    }
    await rename(stage, options.target);
    targetCommitted = true;
    if (ompSelected) {
      await mkdir(path.dirname(options.config), { recursive: true });
      if (await lstat(options.config).catch(() => null)) {
        configBackup = `${options.config}.backup-${Date.now()}`;
        await rename(options.config, configBackup);
      }
      await writeFile(options.config, proposed);
      configCommitted = true;
    }
    const finalConfig = ompSelected ? options.config : proposedConfig;
    const finalVerifyArgs = [path.join(options.target, "solarisael-house-omp", "verify-install.ts"), "--room", path.join(options.target, "rooms", options.room), "--config", finalConfig, "--require-manifest"];
    if (options.substrate) finalVerifyArgs.push("--substrate", options.substrate);
    const finalVerification = await exec(bun, finalVerifyArgs, options.target, { ...process.env, SOLARISAEL_HOUSE_CORE: path.join(options.target, "solarisael-house") });
    if (finalVerification.code) throw new Error(`installed bundle verification failed: ${finalVerification.stdout || finalVerification.stderr}`);
    if (options.mode === "full") {
      const finalResult = JSON.parse(finalVerification.stdout.trim());
      if (finalResult.mode !== "Full") throw new Error("installed Full verification refused: verifier mode is not exactly Full");
    }
    if (configBackup) {
      try { await rm(configBackup, { recursive: true, force: true }); }
      catch (error) { warning = `backup cleanup failed: ${error instanceof Error ? error.message : String(error)}`; }
    }
    if (targetBackup) {
      try { await rm(targetBackup, { recursive: true, force: true }); }
      catch (error) { warning = `target backup cleanup failed: ${error instanceof Error ? error.message : String(error)}`; }
    }
    return { ok: true, target: options.target, room: options.room, harnesses: options.harnesses, updated: options.update, ...(warning ? { warning } : {}) };
  } catch (error) {
    if (configCommitted) await rm(options.config, { force: true }).catch(() => {});
    if (configBackup) await rename(configBackup, options.config).catch(() => {});
    if (targetCommitted) await rm(options.target, { recursive: true, force: true }).catch(() => {});
    if (targetBackup) await rename(targetBackup, options.target).catch(() => {});
    throw error;
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}
try {
  if (process.argv.includes("--list-harnesses")) {
    console.log(JSON.stringify({ ok: true, harnesses: HARNESS_DESCRIPTORS }));
  } else {
    console.log(JSON.stringify(await main()));
  }
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    target: process.argv[process.argv.indexOf("--target") + 1] || "",
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
}
