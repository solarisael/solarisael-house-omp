import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { selectHarnesses, type HarnessId } from "./harnesses.ts";

type Channel = "stable" | "beta" | "experimental";
type Options = {
  target: string;
  room: string;
  mode: "base" | "full";
  config: string;
  substrate?: string;
  repository: string;
  channel: Channel;
  manifestUrl?: string;
  harnesses: HarnessId[];
  check: boolean;
  dryRun: boolean;
  force: boolean;
  apply: boolean;
  receipt: string;
};
type ReleaseAsset = { platform: string; name: string; sha256: string; size: number };
type ReleaseManifest = {
  schemaVersion: 1;
  version: string;
  tag: string;
  channel: Channel;
  repository: string;
  requiredSchemaVersion: number;
  assets: ReleaseAsset[];
};
type GithubAsset = { name?: unknown; browser_download_url?: unknown; size?: unknown; digest?: unknown };
type GithubRelease = { tag_name?: unknown; prerelease?: unknown; assets?: unknown };

const usage = (): never => {
  throw new Error("Usage: updater.ts --target DIR --room ROOM --mode base|full [--config PATH] [--substrate PATH] [--repository OWNER/REPO] [--channel stable|beta|experimental] [--manifest URL] [--harness omp] [--check] [--dry-run] [--force]");
};
const absolute = (value: string) => path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);

function parseArgs(argv: string[]): Options {
  const values = new Map<string, string>();
  const harnessValues: string[] = [];
  let check = false;
  let dryRun = false;
  let force = false;
  let apply = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--check") { check = true; continue; }
    if (argument === "--dry-run") { dryRun = true; continue; }
    if (argument === "--force") { force = true; continue; }
    if (argument === "--apply") { apply = true; continue; }
    if (!["--target", "--room", "--mode", "--config", "--substrate", "--repository", "--channel", "--manifest", "--harness", "--receipt"].includes(argument)) usage();
    const value = argv[++index];
    if (!value || value.startsWith("--")) usage();
    if (argument === "--harness") harnessValues.push(value);
    else values.set(argument, value);
  }
  const target = values.get("--target");
  const room = values.get("--room");
  const mode = values.get("--mode") as "base" | "full";
  const config = values.get("--config") || path.join(os.homedir(), ".omp", "agent", "config.yml");
  const channel = (values.get("--channel") || "stable") as Channel;
  const repository = values.get("--repository") || "solarisael/solarisael-house-omp";
  if (!target || !room || (mode !== "base" && mode !== "full")) usage();
  if (!absolute(target) || !absolute(config)) throw new Error("--target and --config must be absolute paths");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(room) || room === "house") throw new Error("--room must be a safe non-reserved slug");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("--repository must be OWNER/REPO");
  if (!["stable", "beta", "experimental"].includes(channel)) throw new Error("--channel must be stable, beta, or experimental");
  const substrate = values.get("--substrate");
  if (mode === "full" && !substrate) throw new Error("full updates require --substrate");
  const resolvedTarget = path.resolve(target);
  return {
    target: resolvedTarget,
    room,
    mode,
    config: path.resolve(config),
    substrate: substrate ? path.resolve(substrate) : undefined,
    repository,
    channel,
    manifestUrl: values.get("--manifest"),
    harnesses: selectHarnesses(harnessValues),
    check,
    dryRun,
    force,
    apply,
    receipt: path.resolve(values.get("--receipt") || `${resolvedTarget}.update-receipt.json`),
  };
}

function currentPlatform(): string {
  if (process.platform === "win32" && process.arch === "x64") return "windows-x64";
  if (process.platform === "linux" && process.arch === "x64") return "linux-x64";
  if (process.platform === "linux" && process.arch === "arm64") return "linux-arm64";
  throw new Error(`unsupported update platform: ${process.platform}-${process.arch}`);
}

async function requestJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "the-athanor-updater" } });
  if (!response.ok) throw new Error(`request failed ${response.status}: ${url}`);
  return await response.json() as T;
}

function githubAssets(release: GithubRelease): GithubAsset[] {
  if (!Array.isArray(release.assets)) throw new Error("GitHub release assets are missing");
  return release.assets as GithubAsset[];
}

async function githubRelease(options: Options): Promise<GithubRelease> {
  const base = `https://api.github.com/repos/${options.repository}`;
  if (options.channel === "stable") return await requestJson<GithubRelease>(`${base}/releases/latest`);
  const releases = await requestJson<GithubRelease[]>(`${base}/releases?per_page=50`);
  const tagPattern = options.channel === "beta" ? /-beta(?:[.+-]|$)/i : /-(?:experimental|exp)(?:[.+-]|$)/i;
  const release = releases.find((candidate) => candidate.prerelease === true && typeof candidate.tag_name === "string" && tagPattern.test(candidate.tag_name));
  if (!release) throw new Error(`no ${options.channel} release is available`);
  return release;
}

function assetUrl(release: GithubRelease, name: string): string {
  const asset = githubAssets(release).find((candidate) => candidate.name === name);
  if (!asset || typeof asset.browser_download_url !== "string") throw new Error(`release asset is missing: ${name}`);
  return asset.browser_download_url;
}

function validateManifest(value: unknown, options: Options): ReleaseManifest {
  if (!value || typeof value !== "object") throw new Error("release manifest must be an object");
  const manifest = value as Partial<ReleaseManifest>;
  if (manifest.schemaVersion !== 1 || typeof manifest.version !== "string" || typeof manifest.tag !== "string") {
    throw new Error("release manifest identity is invalid");
  }
  if (manifest.repository !== options.repository || manifest.channel !== options.channel) {
    throw new Error("release manifest repository or channel does not match the requested source");
  }
  if (!Number.isSafeInteger(manifest.requiredSchemaVersion) || Number(manifest.requiredSchemaVersion) < 0) {
    throw new Error("release manifest schema requirement is invalid");
  }
  if (!Array.isArray(manifest.assets) || manifest.assets.some((asset) =>
    !asset || typeof asset.platform !== "string" || typeof asset.name !== "string" ||
    asset.name !== path.basename(asset.name) || !/^[a-f0-9]{64}$/.test(asset.sha256) ||
    !Number.isSafeInteger(asset.size) || asset.size <= 0)) {
    throw new Error("release manifest assets are invalid");
  }
  if (new Set(manifest.assets.map((asset) => asset.platform)).size !== manifest.assets.length) {
    throw new Error("release manifest contains duplicate platforms");
  }
  return manifest as ReleaseManifest;
}

async function resolveRelease(options: Options): Promise<{ release: GithubRelease | null; manifest: ReleaseManifest }> {
  if (options.manifestUrl) {
    const manifest = validateManifest(await requestJson<unknown>(options.manifestUrl), options);
    return { release: null, manifest };
  }
  const release = await githubRelease(options);
  const manifest = validateManifest(await requestJson<unknown>(assetUrl(release, "release-manifest.json")), options);
  if (release.tag_name !== manifest.tag) throw new Error("release tag and manifest tag differ");
  return { release, manifest };
}

function parseVersion(value: string): { core: number[]; prerelease: string[] | null } {
  const match = value.trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) throw new Error(`invalid semantic version: ${value}`);
  return { core: match.slice(1, 4).map(Number), prerelease: match[4]?.split(".") || null };
}

function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index++) {
    if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index];
  }
  if (!a.prerelease && !b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index++) {
    const av = a.prerelease[index];
    const bv = b.prerelease[index];
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    if (av === bv) continue;
    const an = /^\d+$/.test(av);
    const bn = /^\d+$/.test(bv);
    if (an && bn) return Number(av) - Number(bv);
    if (an !== bn) return an ? -1 : 1;
    return av.localeCompare(bv);
  }
  return 0;
}

async function installedVersion(target: string): Promise<string | null> {
  const manifestPath = path.join(target, "solarisael-house-omp", "package-manifest.json");
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    return typeof manifest.productVersion === "string" ? manifest.productVersion : null;
  } catch {
    return null;
  }
}

async function download(url: string, destination: string, expected: ReleaseAsset): Promise<void> {
  const response = await fetch(url, { headers: { Accept: "application/octet-stream", "User-Agent": "the-athanor-updater" } });
  if (!response.ok || !response.body) throw new Error(`bundle download failed ${response.status}: ${url}`);
  const file = await open(destination, "w");
  const hash = createHash("sha256");
  let size = 0;
  try {
    const reader = response.body.getReader();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      hash.update(chunk.value);
      size += chunk.value.byteLength;
      await file.write(chunk.value);
    }
  } finally {
    await file.close();
  }
  const digest = hash.digest("hex");
  if (size !== expected.size || digest !== expected.sha256) {
    await rm(destination, { force: true });
    throw new Error(`bundle integrity mismatch: expected ${expected.size}/${expected.sha256}, got ${size}/${digest}`);
  }
}

function run(command: string, args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => stdout += chunk);
    child.stderr?.on("data", (chunk) => stderr += chunk);
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function safeEntry(entry: string): boolean {
  const normalized = entry.replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  return normalized === "" || (normalized !== "." && !normalized.startsWith("/") && !/^[A-Za-z]:/.test(normalized) && !normalized.split("/").includes(".."));
}

async function extractVerified(bundle: string, destination: string): Promise<void> {
  const listing = await run("tar", ["-tf", bundle]);
  if (listing.code) throw new Error(`unable to inspect bundle: ${listing.stderr || listing.stdout}`);
  for (const entry of listing.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    if (!safeEntry(entry)) throw new Error(`unsafe archive entry: ${entry}`);
  }
  const extraction = await run("tar", ["-xf", bundle, "-C", destination]);
  if (extraction.code) throw new Error(`unable to extract bundle: ${extraction.stderr || extraction.stdout}`);
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      const info = await lstat(candidate);
      if (info.isSymbolicLink()) throw new Error(`symlink archive entry refused: ${path.relative(destination, candidate)}`);
      if (info.isDirectory()) await walk(candidate);
    }
  };
  await walk(destination);
}

async function substrateSchemaVersion(substrate: string): Promise<number> {
  const health = path.join(substrate, "health.py");
  const environment = path.join(substrate, ".env");
  if (!(await lstat(health).catch(() => null))?.isFile()) throw new Error(`substrate health probe is missing: ${health}`);
  const result = await run("python", [health, "--env-file", environment, "--skip-embedding"], substrate);
  const parsed = JSON.parse(result.stdout.trim() || "{}");
  const version = parsed?.database?.schemaVersion;
  if (!Number.isSafeInteger(version)) throw new Error(`substrate schema version is unavailable: ${result.stderr || result.stdout}`);
  return version;
}

async function copyToBootstrap(options: Options): Promise<boolean> {
  const executable = path.resolve(process.execPath);
  const inside = executable === options.target || executable.startsWith(`${options.target}${path.sep}`);
  if (!inside || options.apply || options.check || options.dryRun) return false;
  const bootstrapDirectory = path.join(path.dirname(options.target), ".athanor-updater");
  await mkdir(bootstrapDirectory, { recursive: true });
  const bootstrap = path.join(bootstrapDirectory, path.basename(executable));
  await cp(executable, bootstrap, { force: true });
  await writeFile(options.receipt, JSON.stringify({ ok: true, state: "started", target: options.target, startedAt: new Date().toISOString() }, null, 2) + "\n");
  const args = [...process.argv.slice(2), "--apply", "--receipt", options.receipt];
  const child = spawn(bootstrap, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  return true;
}

async function applyUpdate(options: Options): Promise<Record<string, unknown>> {
  if (!(await lstat(options.target).catch(() => null))?.isDirectory()) throw new Error("update target does not exist");
  const { release, manifest } = await resolveRelease(options);
  const platform = currentPlatform();
  const asset = manifest.assets.find((candidate) => candidate.platform === platform);
  if (!asset) throw new Error(`release has no asset for ${platform}`);
  const current = await installedVersion(options.target);
  const comparison = current ? compareVersions(manifest.version, current) : 1;
  if (!options.force && comparison <= 0) {
    return { ok: true, state: "current", currentVersion: current, availableVersion: manifest.version, channel: manifest.channel };
  }
  if (options.mode === "full" && options.substrate) {
    const schemaVersion = await substrateSchemaVersion(options.substrate);
    if (schemaVersion < manifest.requiredSchemaVersion) {
      throw new Error(`release requires substrate schema ${manifest.requiredSchemaVersion}, installed schema is ${schemaVersion}`);
    }
  }
  if (options.check) {
    return { ok: true, state: "available", currentVersion: current, availableVersion: manifest.version, channel: manifest.channel, asset: asset.name };
  }
  const temp = await mkdtemp(path.join(os.tmpdir(), "athanor-update-"));
  try {
    const bundle = path.join(temp, asset.name);
    const url = release
      ? assetUrl(release, asset.name)
      : new URL(asset.name, options.manifestUrl as string).toString();
    await download(url, bundle, asset);
    const extracted = path.join(temp, "release");
    await mkdir(extracted, { recursive: true });
    await extractVerified(bundle, extracted);
    const packageManifestPath = path.join(extracted, "solarisael-house-omp", "package-manifest.json");
    const packageManifest = JSON.parse(await readFile(packageManifestPath, "utf8"));
    if (packageManifest.productVersion !== manifest.version) throw new Error("bundle and release manifest versions differ");
    const installerName = String(packageManifest.installer || "");
    const installer = path.join(extracted, "solarisael-house-omp", installerName);
    if (!(await lstat(installer).catch(() => null))?.isFile()) throw new Error("release installer is missing");
    const args = ["--bundle", bundle, "--target", options.target, "--room", options.room, "--mode", options.mode, "--config", options.config, "--update"];
    if (options.substrate) args.push("--substrate", options.substrate);
    for (const harness of options.harnesses) args.push("--harness", harness);
    if (options.dryRun) args.push("--dry-run");
    const installation = await run(installer, args, temp);
    if (installation.code) throw new Error(`release installer failed: ${installation.stderr || installation.stdout}`);
    const result = JSON.parse(installation.stdout.trim());
    return { ok: true, state: options.dryRun ? "verified" : "updated", previousVersion: current, version: manifest.version, channel: manifest.channel, installer: result };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

const options = parseArgs(process.argv.slice(2));
try {
  if (await copyToBootstrap(options)) {
    console.log(JSON.stringify({ ok: true, state: "started", receipt: options.receipt }));
  } else {
    const result = await applyUpdate(options);
    await writeFile(options.receipt, JSON.stringify({ ...result, completedAt: new Date().toISOString() }, null, 2) + "\n").catch(() => {});
    console.log(JSON.stringify(result));
  }
} catch (error) {
  const result = { ok: false, state: "failed", error: error instanceof Error ? error.message : String(error) };
  await writeFile(options.receipt, JSON.stringify({ ...result, completedAt: new Date().toISOString() }, null, 2) + "\n").catch(() => {});
  console.error(JSON.stringify(result));
  process.exitCode = 1;
}
