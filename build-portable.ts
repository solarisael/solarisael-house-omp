import { cp, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { discoverRustExecutable, rustBinaryName, rustPlatform, RUST_VERSION } from "./discovery.ts";
const adapterRoot = path.dirname(fileURLToPath(import.meta.url));
const projectsRoot = path.dirname(adapterRoot);
const coreRoot = process.env.SOLARISAEL_HOUSE_CORE
  ? path.resolve(process.env.SOLARISAEL_HOUSE_CORE)
  : path.join(projectsRoot, "solarisael-house");

const outputPath = path.resolve(process.argv[2] || path.join(adapterRoot, "dist", "solarisael-house-portable.zip"));

const setup = `Solarisael House — AI-guided OMP bundle

Give README.md and this extracted bundle to a tool-capable AI and ask:

  Install Solarisael House with me. Preserve my existing configuration and
  rooms, explain consequential changes, and guide the first-room session.

INSTALL.md is the complete installation and verification protocol.
IDENTITY_GUIDE.md explains how to co-author a room identity without copying the
fictional example in starter-room/example.

This bundle contains no private rooms, memories, credentials, or substrate data.
`;


function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", windowsHide: true });
    child.on("error", reject);
    child.on("exit", (code) => code === 0
      ? resolve()
      : reject(new Error(`${command} exited with code ${code}`)));
  });
}
async function rustArtifacts(stagingRoot: string): Promise<void> {
  const platform = rustPlatform();
  if (!platform) return;
  const executable = discoverRustExecutable({ env: process.env, moduleDir: adapterRoot });
  if (!executable) return;
  const name = rustBinaryName(platform);
  const destination = path.join(stagingRoot, "solarisael-house-omp", "bin", platform, name);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(executable, destination);
  const hash = createHash("sha256").update(Buffer.from(await Bun.file(destination).arrayBuffer())).digest("hex");
  const details = await stat(destination);
  await writeFile(path.join(stagingRoot, "solarisael-house-omp", "rust-manifest.json"), JSON.stringify({
    version: RUST_VERSION,
    artifacts: [{ platform, path: `bin/${platform}/${name}`, sha256: hash, size: details.size }],
  }, null, 2) + "\n", "utf8");
}

const stagingParent = await mkdtemp(path.join(os.tmpdir(), "solarisael-house-portable-"));
const stagingRoot = path.join(stagingParent, "bundle");

try {
  await mkdir(path.join(stagingRoot, "solarisael-house"), { recursive: true });
  await mkdir(path.join(stagingRoot, "solarisael-house-omp"), { recursive: true });
  await mkdir(path.dirname(outputPath), { recursive: true });

  await cp(path.join(coreRoot, "src"), path.join(stagingRoot, "solarisael-house", "src"), {
    recursive: true,
    filter: (source) => !source.includes("__pycache__"),
  });
  for (const filename of ["index.ts", "package.json", "README.md", "LICENSE", "NOTICE"]) {
    await cp(path.join(coreRoot, filename), path.join(stagingRoot, "solarisael-house", filename));
  }

  await cp(
    path.join(adapterRoot, "solarisael-house-proof"),
    path.join(stagingRoot, "solarisael-house-omp", "solarisael-house-proof"),
    { recursive: true },
  );
  await cp(
    path.join(adapterRoot, "commands"),
    path.join(stagingRoot, "solarisael-house-omp", "commands"),
    { recursive: true },
  ).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  for (const filename of ["index.ts", "discovery.ts", "hygiene.ts", "package.json", "README.md", "LICENSE", "NOTICE"]) {
    await cp(path.join(adapterRoot, filename), path.join(stagingRoot, "solarisael-house-omp", filename));
  }


  for (const filename of ["README.md", "INSTALL.md", "USAGE.md", "IDENTITY_GUIDE.md", "LICENSE", "NOTICE"]) {
    await cp(path.join(coreRoot, filename), path.join(stagingRoot, filename));
  }
  await cp(
    path.join(adapterRoot, "verify-install.ts"),
    path.join(stagingRoot, "solarisael-house-omp", "verify-install.ts"),
  );
  await cp(
    path.join(adapterRoot, "starter-room"),
    path.join(stagingRoot, "starter-room"),
    { recursive: true },
  );
  await rustArtifacts(stagingRoot);

  await writeFile(path.join(stagingRoot, "SETUP.txt"), setup, "utf8");

  await rm(outputPath, { force: true });
  await run("tar", ["-a", "-c", "-f", outputPath, "-C", stagingRoot, "."], adapterRoot);
  console.log(outputPath);
} finally {
  await rm(stagingParent, { recursive: true, force: true });
}
