import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

type Mode = "base" | "full";
type Options = { bundle: string; target: string; room: string; mode: Mode; force: boolean; dryRun: boolean; config: string; substrate?: string };
type Result = { ok: boolean; target: string; room?: string; dryRun?: boolean; warning?: string; error?: string };
const usage = (): never => { throw new Error("Usage: installer.ts --bundle ZIP --target DIR --room ROOM --mode base|full [--config ABSOLUTE_PATH] [--substrate PATH] [--force] [--dry-run]"); };
const isAbsolute = (v: string) => path.isAbsolute(v) || /^[A-Za-z]:[\\/]/.test(v) || /^\\\\/.test(v);
function parseArgs(argv: string[]): Options {
  const values = new Map<string, string>(); let force = false, dryRun = false;
  for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a === "--force") { force = true; continue; } if (a === "--dry-run") { dryRun = true; continue; } if (!["--bundle", "--target", "--room", "--mode", "--config", "--substrate"].includes(a)) usage(); const v = argv[++i]; if (!v || v.startsWith("--")) usage(); values.set(a, v); }
  const bundle = values.get("--bundle"), target = values.get("--target"), room = values.get("--room"), mode = values.get("--mode") as Mode;
  const config = values.get("--config") || path.join(os.homedir(), ".omp", "agent", "config.yml");
  if (!bundle || !target || !room || (mode !== "base" && mode !== "full")) usage();
  if (!isAbsolute(target) || !isAbsolute(config)) throw new Error("--target and --config must be absolute paths");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(room) || room === "house") throw new Error("--room must be a safe non-reserved slug");
  return { bundle: path.resolve(bundle), target: path.resolve(target), room, mode, force, dryRun, config: path.resolve(config), substrate: values.get("--substrate") };
}
function exec(command: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> { return new Promise((resolve, reject) => { const c = spawn(command, args, { cwd, env, windowsHide: true }); let stdout = "", stderr = ""; c.stdout?.on("data", d => stdout += d); c.stderr?.on("data", d => stderr += d); c.on("error", reject); c.on("exit", code => resolve({ code: code ?? -1, stdout, stderr })); }); }
function safeEntry(entry: string) { const n = entry.replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+$/, ""); return n === "" || (n !== "." && !n.startsWith("/") && !/^[A-Za-z]:/.test(n) && !n.split("/").includes("..")); }
async function archiveEntries(bundle: string) { const r = await exec("tar", ["-tf", bundle]); if (r.code) throw new Error(`unable to read bundle: ${r.stderr || r.stdout}`); const e = r.stdout.split(/\r?\n/).map(x => x.trim()).filter(Boolean); for (const x of e) if (!safeEntry(x)) throw new Error(`unsafe archive entry: ${x}`); return e.map(x => x.replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+$/, "")).filter(Boolean); }
const required = ["solarisael-house/index.ts", "solarisael-house-omp/index.ts", "solarisael-house-omp/discovery.ts", "solarisael-house-omp/hygiene.ts", "solarisael-house-omp/verify-install.ts", "starter-room/example/.solarisael-room.json", "starter-room/example/active_spirit.md", "starter-room/example/AGENTS.md"];
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
async function main(): Promise<Result> { const o = parseArgs(process.argv.slice(2)); const exists = !!await lstat(o.target).catch(() => null); if (exists && !o.force) throw new Error("target already exists; pass --force to replace it"); const bi = await lstat(o.bundle).catch(() => null); if (!bi?.isFile()) throw new Error("bundle must be a regular file"); const entries = await archiveEntries(o.bundle); for (const x of required) if (!entries.includes(x)) throw new Error(`bundle missing required file: ${x}`); if (!o.dryRun) await mkdir(path.dirname(o.target), { recursive: true }); const temp = await mkdtemp(path.join(o.dryRun ? os.tmpdir() : path.dirname(o.target), ".solarisael-house-install-")), stage = path.join(temp, "install"); let targetBackup: string | undefined, configBackup: string | undefined, targetCommitted = false, configCommitted = false, warning: string | undefined;
  try { await mkdir(stage, { recursive: true }); const x = await exec("tar", ["-xf", o.bundle, "-C", stage]); if (x.code) throw new Error(`bundle extraction failed: ${x.stderr || x.stdout}`); await noSymlinks(stage); if (exists && o.force) await mergeMissing(o.target, stage); await configure(stage, o.room); if (o.mode === "full") { if (!o.substrate) throw new Error("full mode requires a substrate path/config"); await assertRust(stage); }
    const cfg = await readFile(o.config, "utf8").catch(() => "");
    const proposed = wireConfig(cfg, o.target);
    const proposedConfig = path.join(temp, "config.yml");
    await writeFile(proposedConfig, wireConfig(cfg, stage));
    const bun = /(?:^|[\\/])bun(?:\.exe)?$/i.test(process.execPath) ? process.execPath : "bun";
    const verifyArgs = [path.join(stage, "solarisael-house-omp", "verify-install.ts"), "--room", path.join(stage, "rooms", o.room), "--config", proposedConfig];
    if (o.substrate) verifyArgs.push("--substrate", o.substrate);
    const v = await exec(bun, verifyArgs, stage, { ...process.env, SOLARISAEL_HOUSE_CORE: path.join(stage, "solarisael-house") });
    if (v.code) throw new Error(`bundle verification failed: ${v.stdout || v.stderr}`);
    if (o.mode === "full") {
      let j: any;
      try { j = JSON.parse(v.stdout.trim().split(/\r?\n/).pop() || "{}"); }
      catch { throw new Error("Full verification did not return JSON"); }
      if (j.mode !== "Full") throw new Error("Full verification refused: verifier mode is not exactly Full");
    }
    if (o.dryRun) return { ok: true, target: o.target, room: o.room, dryRun: true };
    if (exists) {
      targetBackup = `${o.target}.backup-${Date.now()}`;
      await rename(o.target, targetBackup);
    }
    await rename(stage, o.target);
    targetCommitted = true;
    await mkdir(path.dirname(o.config), { recursive: true });
    if (await lstat(o.config).catch(() => null)) {
      configBackup = `${o.config}.backup-${Date.now()}`;
      await rename(o.config, configBackup);
    }
    await writeFile(o.config, proposed);
    configCommitted = true;
    const finalVerifyArgs = [path.join(o.target, "solarisael-house-omp", "verify-install.ts"), "--room", path.join(o.target, "rooms", o.room), "--config", o.config];
    if (o.substrate) finalVerifyArgs.push("--substrate", o.substrate);
    const finalVerification = await exec(bun, finalVerifyArgs, o.target, { ...process.env, SOLARISAEL_HOUSE_CORE: path.join(o.target, "solarisael-house") });
    if (finalVerification.code) throw new Error(`installed bundle verification failed: ${finalVerification.stdout || finalVerification.stderr}`);
    if (o.mode === "full") {
      const finalResult = JSON.parse(finalVerification.stdout.trim().split(/\r?\n/).pop() || "{}");
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
    return { ok: true, target: o.target, room: o.room, ...(warning ? { warning } : {}) };
  } catch (e) { if (configCommitted) await rm(o.config, { force: true }).catch(() => {}); if (configBackup) await rename(configBackup, o.config).catch(() => {}); if (targetCommitted) await rm(o.target, { recursive: true, force: true }).catch(() => {}); if (targetBackup) await rename(targetBackup, o.target).catch(() => {}); throw e; } finally { await rm(temp, { recursive: true, force: true }).catch(() => {}); }
}
try { console.log(JSON.stringify(await main())); } catch (e) { console.error(JSON.stringify({ ok: false, target: process.argv[process.argv.indexOf("--target") + 1] || "", error: e instanceof Error ? e.message : String(e) })); process.exitCode = 1; }
