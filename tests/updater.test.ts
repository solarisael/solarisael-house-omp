import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const adapterRoot = path.resolve(import.meta.dir, "..");
const updater = path.join(adapterRoot, "updater.ts");
const roots: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];

type CommandResult = { code: number; stdout: string; stderr: string };

function run(command: string, args: string[], cwd?: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => stdout += chunk);
    child.stderr.on("data", (chunk) => stderr += chunk);
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function platform(): string {
  if (process.platform === "win32" && process.arch === "x64") return "windows-x64";
  if (process.platform === "linux" && process.arch === "x64") return "linux-x64";
  if (process.platform === "linux" && process.arch === "arm64") return "linux-arm64";
  throw new Error(`unsupported test platform: ${process.platform}-${process.arch}`);
}

async function releaseFixture(options: {
  currentVersion: string;
  availableVersion: string;
  validBundle?: boolean;
  corruptDigest?: boolean;
}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "house-updater-test-"));
  roots.push(root);
  const target = path.join(root, "installed-house");
  const config = path.join(root, "config.yml");
  const receipt = path.join(root, "receipt.json");
  await mkdir(path.join(target, "solarisael-house-omp"), { recursive: true });
  await writeFile(
    path.join(target, "solarisael-house-omp", "package-manifest.json"),
    JSON.stringify({ schemaVersion: 2, productVersion: options.currentVersion }),
  );
  await writeFile(config, "extensions:\n");

  const assetName = "release.zip";
  const bundle = path.join(root, assetName);
  if (options.validBundle) {
    const tree = path.join(root, "release-tree");
    const packagedAdapter = path.join(tree, "solarisael-house-omp");
    await mkdir(packagedAdapter, { recursive: true });
    const installerSource = path.join(root, "fixture-installer.ts");
    const installerName = process.platform === "win32" ? "install.exe" : "install";
    await writeFile(installerSource, "console.log(JSON.stringify({ok:true,args:process.argv.slice(1)}));\n");
    const compiled = await run(process.execPath, ["build", installerSource, "--compile", "--outfile", path.join(packagedAdapter, installerName)], root);
    if (compiled.code !== 0) throw new Error(`fixture installer compilation failed: ${compiled.stdout}${compiled.stderr}`);
    await writeFile(
      path.join(packagedAdapter, "package-manifest.json"),
      JSON.stringify({ schemaVersion: 2, productVersion: options.availableVersion, installer: installerName }),
    );
    const archived = await run("tar", ["-a", "-c", "-f", bundle, "-C", tree, "."], root);
    if (archived.code !== 0) throw new Error(`fixture archive failed: ${archived.stdout}${archived.stderr}`);
  } else {
    await writeFile(bundle, "local updater fixture");
  }

  const bytes = await readFile(bundle);
  const sha256 = options.corruptDigest
    ? "0".repeat(64)
    : createHash("sha256").update(bytes).digest("hex");
  const manifest = {
    schemaVersion: 1,
    version: options.availableVersion,
    tag: `v${options.availableVersion}`,
    channel: "stable",
    repository: "solarisael/solarisael-house-omp",
    requiredSchemaVersion: 8,
    assets: [{ platform: platform(), name: assetName, sha256, size: bytes.byteLength }],
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/release-manifest.json") return Response.json(manifest);
      if (pathname === `/${assetName}`) return new Response(bytes);
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  const manifestUrl = new URL("release-manifest.json", server.url).toString();
  const args = [
    "--target", target,
    "--room", "demo-room",
    "--mode", "base",
    "--config", config,
    "--manifest", manifestUrl,
    "--receipt", receipt,
  ];
  return { root, target, receipt, args };
}

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.serial("release updater", () => {
  test("reports current without downloading an already installed release", async () => {
    const fixture = await releaseFixture({ currentVersion: "1.2.3", availableVersion: "1.2.3" });
    const result = await run(process.execPath, [updater, ...fixture.args], fixture.root);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      state: "current",
      currentVersion: "1.2.3",
      availableVersion: "1.2.3",
      channel: "stable",
    });
  });

  test("reports an available newer release in check mode", async () => {
    const fixture = await releaseFixture({ currentVersion: "1.2.3", availableVersion: "1.3.0" });
    const result = await run(process.execPath, [updater, ...fixture.args, "--check"], fixture.root);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      state: "available",
      currentVersion: "1.2.3",
      availableVersion: "1.3.0",
      asset: "release.zip",
    });
  });

  test("refuses a bundle whose streamed digest differs from the release manifest", async () => {
    const fixture = await releaseFixture({ currentVersion: "1.2.3", availableVersion: "1.3.0", corruptDigest: true });
    const installedManifest = path.join(fixture.target, "solarisael-house-omp", "package-manifest.json");
    const before = await readFile(installedManifest, "utf8");
    const result = await run(process.execPath, [updater, ...fixture.args], fixture.root);

    expect(result.code).not.toBe(0);
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, state: "failed" });
    expect(result.stderr).toContain("bundle integrity mismatch");
    expect(await readFile(installedManifest, "utf8")).toBe(before);
    expect(await stat(fixture.receipt)).toBeDefined();
  });

  test("propagates the selected harness to the compiled installer", async () => {
    const fixture = await releaseFixture({ currentVersion: "1.2.3", availableVersion: "1.3.0", validBundle: true });
    const result = await run(process.execPath, [updater, ...fixture.args, "--harness", "omp", "--harness", "omp"], fixture.root);

    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({ ok: true, state: "updated", previousVersion: "1.2.3", version: "1.3.0" });
    expect(output.installer.args).toEqual(expect.arrayContaining(["--update", "--harness", "omp"]));
    expect(output.installer.args.filter((value: string) => value === "--harness")).toHaveLength(1);
  }, 20_000);
});
