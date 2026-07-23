import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { createReadStream, existsSync, statSync } from "node:fs";
import { join, resolve, sep, extname } from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { RustJsonlTransport } from "./rust-transport.ts";
import { discoverRustExecutable } from "./discovery.ts";

const MAX_BODY = 256 * 1024;
const MAX_OUTPUT = 256 * 1024;
const RPC_METHODS = new Set(["remember", "recall", "anamnesis", "anamnesis_write", "cluster_maintenance"]);
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

export interface GuiServerOptions {
  executable: string;
  args?: string[];
  cwd?: string;
  port?: number;
  backupRoot?: string;
  backupKeep?: number;
  databasePath?: string;
  host?: string;
  room?: string;
}
export interface GuiServerHandle { server: ReturnType<typeof createServer>; csrfToken: string; port: number; close(): Promise<void> }

function json(res: ServerResponse, status: number, value: unknown) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(body);
}
function headers(res: ServerResponse) {
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  res.setHeader("x-content-type-options", "nosniff");
}
async function body(req: IncomingMessage): Promise<Buffer> {
  const len = Number(req.headers["content-length"] ?? 0);
  if (len > MAX_BODY) throw Object.assign(new Error("payload too large"), { status: 413 });
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { const b = Buffer.from(chunk as Buffer); size += b.length; if (size > MAX_BODY) throw Object.assign(new Error("payload too large"), { status: 413 }); chunks.push(b); }
  return Buffer.concat(chunks);
}
async function killTree(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.pid && process.platform === "win32") {
    await new Promise<void>((resolveKill) => {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { shell: false, windowsHide: true, stdio: "ignore" });
      killer.once("close", () => resolveKill());
      killer.once("error", () => resolveKill());
    });
  } else if (child.pid) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  } else child.kill();
}
function command(executable: string, args: string[], cwd: string | undefined, timeout: number): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = []; let n = 0; let settled = false; let timedOut = false;
    let timer: ReturnType<typeof setTimeout>;
    const collect = (c: Buffer) => { if (n < MAX_OUTPUT) { const x = c.subarray(0, MAX_OUTPUT - n); out.push(x); n += x.length; } };
    const finish = (fn: (v: any) => void, v: any) => { if (settled) return; settled = true; clearTimeout(timer); fn(v); };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    child.on("error", e => finish(reject, e));
    child.on("close", (code, signal) => finish(timedOut ? reject : code === 0 ? resolvePromise : reject, timedOut ? new Error("command timed out") : code === 0 ? { ok: true, output: Buffer.concat(out).toString("utf8") } : new Error(`command failed (${signal ?? code})`)));
    timer = setTimeout(async () => { timedOut = true; await killTree(child); }, timeout);
  });
}

export function createGuiServer(options: GuiServerOptions): GuiServerHandle {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost") throw new Error("GUI server must bind to 127.0.0.1 or localhost");
  const csrfToken = randomBytes(32).toString("hex");
  let transport = new RustJsonlTransport({ executable: options.executable, args: options.args, cwd: options.cwd });
  const requestRust = async (method: string, params: Record<string, unknown>, requestOptions: { timeoutMs?: number; settleDefinitively?: boolean } = {}) => {
    try { return await transport.request(method, params, requestOptions); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/transport|child exited|closed|unusable|output line/i.test(message)) { transport.close(); transport = new RustJsonlTransport({ executable: options.executable, args: options.args, cwd: options.cwd }); }
      throw error;
    }
  };
  const root = resolve(options.cwd ?? process.cwd(), "gui");
  const server = createServer(async (req, res) => {
    headers(res);
    try {
      const url = new URL(req.url ?? "/", `http://${host}`);
      const actualPort = (server.address() as { port?: number } | null)?.port;
      const authority = actualPort ? `${host}:${actualPort}` : "";
      if (req.headers.host !== authority) { json(res, 403, { ok: false, error: "invalid host" }); return; }
      if (req.method === "POST" && req.headers.origin !== `http://${authority}`) { json(res, 403, { ok: false, error: "invalid origin" }); return; }
      if (req.method === "GET" && url.pathname === "/api/csrf") { json(res, 200, { token: csrfToken }); return; }
      if (req.method === "GET" && url.pathname === "/api/backups") {
        if (!options.backupRoot) { json(res, 200, { ok: true, backups: [] }); return; }
        const { readdir } = await import("node:fs/promises");
        const base = resolve(options.backupRoot); const entries = await readdir(base, { withFileTypes: true });
        json(res, 200, { ok: true, backups: entries.filter(e => e.isFile()).map(e => e.name).slice(0, 100) }); return;
      }
      if (req.method === "GET" && url.pathname === "/api/health") {
        try { const result = await requestRust("cluster_maintenance", { operation: "check", room: options.room ?? "gui" }, { timeoutMs: 15000 }); json(res, 200, { ok: true, status: "running", cluster: result }); }
        catch (e) { json(res, 503, { ok: false, status: "unhealthy", error: e instanceof Error ? e.message : String(e) }); }
        return;
      }
      if (req.method === "POST" && (url.pathname === "/api/rpc" || url.pathname === "/api/backup" || url.pathname === "/api/restore")) {
        if (req.headers["x-csrf-token"] !== csrfToken) { json(res, 403, { ok: false, error: "csrf" }); return; }
        const raw = await body(req); let input: any;
        try { input = JSON.parse(raw.toString("utf8")); } catch { json(res, 400, { ok: false, error: "invalid json" }); return; }
        if (!input || typeof input !== "object" || Array.isArray(input)) { json(res, 400, { ok: false, error: "object required" }); return; }
        if (url.pathname === "/api/rpc") {
          const params = input.params;
          if (typeof input.method !== "string" || !RPC_METHODS.has(input.method)) { json(res, 400, { ok: false, error: "method not allowed" }); return; }
          if (!params || typeof params !== "object" || Array.isArray(params)) { json(res, 400, { ok: false, error: "params must be object" }); return; }
          if (input.method === "cluster_maintenance" && (params as any).operation === "rebuild" && (params as any).confirm !== "REBUILD") { json(res, 400, { ok: false, error: "rebuild confirmation required" }); return; }
          const rpcParams = { ...(params as Record<string, unknown>) };
          delete rpcParams.confirm;
          const definitive = input.method === "remember" || input.method === "anamnesis_write";
          const result = await requestRust(input.method, rpcParams, definitive ? { settleDefinitively: true } : { timeoutMs: 15000 });
          json(res, 200, { ok: true, result }); return;
        }
        if (url.pathname === "/api/backup") {
          if (!options.backupRoot) { json(res, 400, { ok: false, error: "backup is not configured" }); return; }
          const keep = options.backupKeep ?? 5;
          const result = await command(options.executable, [...(options.args ?? []), "backup", "--output-dir", resolve(options.backupRoot), "--keep", String(keep)], options.cwd, 60000); json(res, 200, result); return;
        }
        const target = typeof input.targetDb === "string" ? input.targetDb : "";
        const confirm = typeof input.confirm === "string" ? input.confirm : "";
        const manifest = typeof input.manifest === "string" ? input.manifest : "";
        const expected = options.databasePath ?? "";
        if (!expected || !options.backupRoot) { json(res, 400, { ok: false, error: "restore is not configured" }); return; }
        if (target !== expected || confirm !== `RESTORE ${expected}`) { json(res, 400, { ok: false, error: "typed confirmation required" }); return; }
        const backupRoot = resolve(options.backupRoot); const selected = resolve(backupRoot, manifest);
        if (!manifest || (selected !== backupRoot && !selected.startsWith(backupRoot + sep)) || !existsSync(selected) || !statSync(selected).isFile()) { json(res, 400, { ok: false, error: "invalid manifest" }); return; }
        const result = await command(options.executable, [...(options.args ?? []), "restore", "--manifest", selected, "--confirm-database", target], options.cwd, 60000); json(res, 200, result); return;
      }
      if (req.method === "GET") {
        let asset = url.pathname === "/" ? "/index.html" : url.pathname;
        if (asset.includes("..") || asset.includes("\\") || !/^\/[\w./-]+$/.test(asset)) { res.writeHead(404); res.end("Not found"); return; }
        const file = resolve(root, "." + asset); if (file !== root && !file.startsWith(root + sep)) { res.writeHead(404); res.end("Not found"); return; }
        const data = await readFile(file); res.setHeader("content-type", MIME[extname(file)] ?? "application/octet-stream"); res.end(data); return;
      }
      json(res, 404, { ok: false, error: "not found" });
    } catch (e: any) { json(res, e?.status === 413 ? 413 : 500, { ok: false, error: e instanceof Error ? e.message : String(e) }); }
  });
  return { server, csrfToken, port: options.port ?? 0, close: async () => { transport.close(); await new Promise<void>(resolveClose => server.close(() => resolveClose())); } };
}
export async function startGuiServer(options: GuiServerOptions): Promise<GuiServerHandle> {
  const handle = createGuiServer(options); await new Promise<void>((resolveListen, reject) => { handle.server.once("error", reject); handle.server.listen(handle.port, options.host ?? "127.0.0.1", resolveListen); });
  handle.port = (handle.server.address() as any).port; return handle;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (flag: string) => {
    const index = args.indexOf(flag);
    if (index < 0 || !args[index + 1]) throw new Error(`${flag} requires a value`);
    return args[index + 1];
  };
  const executable = discoverRustExecutable({ env: process.env, moduleDir: import.meta.dir });
  if (!executable) throw new Error("Rust substrate not selected; set SOLARISAEL_HOUSE_RUST or SOLARISAEL_HOUSE_RUST_AUTO=1");
  const room = args.includes("--room") ? value("--room") : "gui";
  const port = args.includes("--port") ? Number(value("--port")) : 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be an integer from 0 to 65535");
  const handle = await startGuiServer({
    executable,
    room,
    port,
    backupRoot: args.includes("--backup-root") ? value("--backup-root") : undefined,
    databasePath: args.includes("--database") ? value("--database") : undefined,
  });
  console.log(`http://127.0.0.1:${handle.port}`);
}
