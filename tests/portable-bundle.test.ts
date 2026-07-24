import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

const tempRoots: string[] = [];
const adapterRoot = path.resolve(import.meta.dir, "..");
const constantsModule = pathToFileURL(path.join(adapterRoot, "solarisael-house-proof", "constants.ts")).href;
const hygieneModule = pathToFileURL(path.join(adapterRoot, "hygiene.ts")).href;
const portableBuilder = path.join(adapterRoot, "build-portable.ts");

function runAllowFailure(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

async function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<CommandResult> {
  const result = await runAllowFailure(command, args, cwd, env);
  if (result.exitCode !== 0) {
    throw new Error(`${command} exited with code ${result.exitCode}\n${result.stdout}${result.stderr}`);
  }
  return result;
}

function isolatedEnv(home: string, overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const drive = path.parse(home).root.replace(/[\\/]+$/, "");
  const relativeHome = path.relative(path.parse(home).root, home).replaceAll("/", "\\");

  return {
    PATH: process.env.PATH,
    PATHEXT: process.env.PATHEXT,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    ComSpec: process.env.ComSpec,
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: drive,
    HOMEPATH: relativeHome ? `\\${relativeHome}` : "\\",
    TEMP: path.join(home, "temp"),
    TMP: path.join(home, "temp"),
    SOLARISAEL_TEST_NATIVE_PYTHON: process.env.SOLARISAEL_TEST_NATIVE_PYTHON,
    ...overrides,
  };
}

async function makeTempRoot(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function runConstantsProbe(env: NodeJS.ProcessEnv) {
  const root = await makeTempRoot("omp-portable-probe-");
  const probe = path.join(root, "probe.ts");
  await writeFile(
    probe,
    `import path from "node:path";
import { HOUSE_CORE_ROOT, OBSIDIAN_ROOT } from ${JSON.stringify(constantsModule)};
import { isInTrackedTree } from ${JSON.stringify(hygieneModule)};

console.log(JSON.stringify({
  houseCoreRoot: HOUSE_CORE_ROOT,
  obsidianRoot: OBSIDIAN_ROOT,
  vaultPathIsTracked: isInTrackedTree(path.join(OBSIDIAN_ROOT, "example-room", "note.tmp"), () => false),
}));
`,
    "utf8",
  );

  const result = await run(process.execPath, [probe], root, env);
  return JSON.parse(result.stdout) as {
    houseCoreRoot: string;
    obsidianRoot: string;
    vaultPathIsTracked: boolean;
  };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("portable bundle path contract", () => {
  test("names the canonical sibling directory as the default bundle core", async () => {
    const builderSource = await readFile(portableBuilder, "utf8");

    expect(builderSource).toContain('path.join(projectsRoot, "the-athanor")');
    expect(builderSource).not.toContain('path.join(projectsRoot, "solarisael-house")');
  });

  test("honors SOLARISAEL_HOUSE_CORE in a separate Bun process, not a cached constants module", async () => {
    const root = await makeTempRoot("omp-portable-core-override-");
    const home = path.join(root, "home");
    const alternateCore = path.join(root, "alternate-core");
    await mkdir(home, { recursive: true });
    await mkdir(alternateCore, { recursive: true });

    const result = await runConstantsProbe(isolatedEnv(home, {
      SOLARISAEL_HOUSE_CORE: alternateCore,
    }));

    expect(result.houseCoreRoot).toBe(path.resolve(alternateCore));
  });

  test("uses an isolated SOLARISAEL_VAULT_ROOT for both constants and hygiene", async () => {
    const root = await makeTempRoot("omp-portable-vault-override-");
    const home = path.join(root, "home");
    const vault = path.join(root, "portable-vault");
    await mkdir(home, { recursive: true });
    await mkdir(vault, { recursive: true });

    const result = await runConstantsProbe(isolatedEnv(home, {
      SOLARISAEL_VAULT_ROOT: vault,
    }));

    expect(result.obsidianRoot).toBe(path.resolve(vault));
    expect(result.vaultPathIsTracked).toBe(true);
  });

  test("falls back to the isolated home directory's Solarisael vault", async () => {
    const root = await makeTempRoot("omp-portable-vault-fallback-");
    const home = path.join(root, "home");
    await mkdir(home, { recursive: true });

    const result = await runConstantsProbe(isolatedEnv(home));

    expect(result.obsidianRoot).toBe(path.join(home, "Solarisael"));
    expect(result.vaultPathIsTracked).toBe(true);
  });
});

describe("portable bundle builder safety", () => {
  test("builds from an explicit temporary core without changing the isolated OMP config or hard-coded runtime roots", async () => {
    const root = await makeTempRoot("omp-portable-build-");
    const home = path.join(root, "home");
    const configPath = path.join(home, ".omp", "agent", "config.yml");
    const core = path.join(root, "portable-core");
    const stagedAdapter = path.join(root, "solarisael-house-omp");
    const stagedBuilder = path.join(stagedAdapter, "build-portable.ts");
    const output = path.join(root, "portable.zip");
    const configBefore = "extensions:\n  - keep-this-config-untouched.ts\n";

    await mkdir(path.dirname(configPath), { recursive: true });
    await mkdir(path.join(home, "temp"), { recursive: true });
    await mkdir(path.join(core, "src"), { recursive: true });
    await mkdir(path.join(stagedAdapter, "commands"), { recursive: true });
    await mkdir(path.join(stagedAdapter, "solarisael-house-proof"), { recursive: true });
    await cp(portableBuilder, stagedBuilder);
    for (const filename of ["discovery.ts", "rust-transport.ts", "gui-server.ts", "installer.ts"]) await cp(path.join(adapterRoot, filename), path.join(stagedAdapter, filename));
    await cp(path.join(adapterRoot, "gui"), path.join(stagedAdapter, "gui"), { recursive: true });
    await cp(path.join(adapterRoot, "discovery.ts"), path.join(stagedAdapter, "discovery.ts"));
    for (const filename of ["README.md", "INSTALL.md", "USAGE.md", "IDENTITY_GUIDE.md", "LICENSE", "NOTICE"]) {
      await cp(path.join(adapterRoot, "..", "the-athanor", filename), path.join(core, filename));
    }
    for (const filename of ["README.md", "LICENSE", "NOTICE", "verify-install.ts"]) {
      await cp(path.join(adapterRoot, filename), path.join(stagedAdapter, filename));
    }
    await cp(path.join(adapterRoot, "starter-room"), path.join(stagedAdapter, "starter-room"), { recursive: true });
    await writeFile(path.join(stagedAdapter, "index.ts"), "export {};\n", "utf8");
    await writeFile(path.join(stagedAdapter, "hygiene.ts"), "export {};\n", "utf8");
    await writeFile(path.join(stagedAdapter, "package.json"), '{"name":"portable-adapter"}\n', "utf8");
    await writeFile(configPath, configBefore, "utf8");
    await writeFile(path.join(core, "src", "portable-sentinel.ts"), "export const sentinel = true;\n", "utf8");
    await writeFile(path.join(core, "index.ts"), "export {};\n", "utf8");
    await writeFile(path.join(core, "package.json"), '{"name":"portable-core"}\n', "utf8");
    await run(process.execPath, [stagedBuilder, output], stagedAdapter, isolatedEnv(home, {
      SOLARISAEL_HOUSE_CORE: core,
      SOLARISAEL_HOUSE_RUST: process.execPath,
    }));

    expect(await readFile(configPath, "utf8")).toBe(configBefore);
    expect((await stat(output)).size).toBeGreaterThan(0);

    const archive = await run("tar", ["-tf", output], root, isolatedEnv(home));
    expect(archive.stdout).toMatch(/solarisael-house[\\/]src[\\/]portable-sentinel\.ts/);
    expect(archive.stdout).toMatch(/solarisael-house-omp[\\/]discovery\.ts/);
    expect(archive.stdout).toMatch(/solarisael-house-omp[\\/]index\.ts/);

    const builderSource = await readFile(portableBuilder, "utf8");
    expect(builderSource).toContain("path.dirname(adapterRoot)");
    expect(builderSource).not.toMatch(/[Cc]:[\\/](?:Projects|Solarisael)(?:[\\/]|$)/);
  });
  test("includes the AI-native onboarding assets at the portable archive root", async () => {
    const root = await makeTempRoot("omp-portable-onboarding-");
    const home = path.join(root, "home");
    const output = path.join(root, "portable-onboarding.zip");
    await mkdir(path.join(home, "temp"), { recursive: true });
    await run(process.execPath, [portableBuilder, output], adapterRoot, isolatedEnv(home, {
      SOLARISAEL_HOUSE_RUST: process.execPath,
    }));

    const archive = await run("tar", ["-tf", output], root, isolatedEnv(home));
    const entries = archive.stdout
      .split(/\r?\n/)
      .map((entry) => entry.replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+$/, ""))
      .filter(Boolean);

    expect(entries).toEqual(expect.arrayContaining([
      "README.md",
      "INSTALL.md",
      "USAGE.md",
      "IDENTITY_GUIDE.md",
      "LICENSE",
      "NOTICE",
      "starter-room/example/.solarisael-room.json",
      "starter-room/example/AGENTS.md",
      "starter-room/example/active_spirit.md",
      "solarisael-house/README.md",
      "solarisael-house/LICENSE",
      "solarisael-house/NOTICE",
      "solarisael-house-omp/README.md",
      "solarisael-house-omp/LICENSE",
      "solarisael-house-omp/NOTICE",
      "solarisael-house-omp/verify-install.ts",
      "solarisael-house-omp/rust-transport.ts",
      "solarisael-house-omp/gui-server.ts",
      "solarisael-house-omp/installer.ts",
      "solarisael-house-omp/gui/index.html",
      "solarisael-house-omp/gui/app.js",
      "solarisael-house-omp/gui/style.css",
      "solarisael-house-omp/install.exe",
      "solarisael-house-omp/package-manifest.json",
    ]));
    expect(entries).not.toContain("verify-install.ts");
    expect(entries.some((entry) => entry.startsWith("solarisael-house-substrate/"))).toBe(false);
  }, 15_000);
  test("verifies a complete generic room and reports a missing host context entrypoint", async () => {
    const root = await makeTempRoot("omp-portable-verify-");
    const home = path.join(root, "home");
    const room = path.join(root, "example");
    const configPath = path.join(home, ".omp", "agent", "config.yml");
    const core = path.resolve(adapterRoot, "..", "the-athanor");
    const verifyInstaller = path.join(adapterRoot, "verify-install.ts");
    const trueName = "Example Room";
    const operator = "Ada Lovelace";

    await mkdir(path.join(home, "temp"), { recursive: true });
    await mkdir(room, { recursive: true });
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      path.join(room, ".solarisael-room.json"),
      `${JSON.stringify({ version: 1, room: "example", trueName, operator }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(room, "active_spirit.md"),
      [
        `# Active Spirit: ${trueName}`,
        `Agent: ${trueName} | Operator: ${operator}`,
        `Embodied: ${trueName} | Conjured: none | Summoned: none`,
        "",
        `# SPIRIT: ${trueName}`,
        "A complete portable room identity.",
        "",
      ].join("\n"),
      "utf8",
    );
    const agentsPath = path.join(room, "AGENTS.md");
    await writeFile(agentsPath, "Read @active_spirit.md and @room_summary.md before acting.\n", "utf8");
    await writeFile(
      configPath,
      `extensions:\n  - ${path.join(adapterRoot, "index.ts")}\n  - ${path.join(adapterRoot, "hygiene.ts")}\n`,
      "utf8",
    );

    const env = isolatedEnv(home, { SOLARISAEL_HOUSE_CORE: core });
    const args = ["--room", room, "--config", configPath];
    const success = await runAllowFailure(process.execPath, [verifyInstaller, ...args], adapterRoot, env);
    expect(success.exitCode).toBe(0);
    expect(JSON.parse(success.stdout)).toMatchObject({
      ok: true,
      roomPath: room,
    });
    expect(JSON.parse(success.stdout)).toMatchObject({
      mode: "Base",
      staticOk: true,
      runtimeHealth: { state: "not-configured", ok: null },
    });


    const substrate = path.join(root, "substrate");
    const contract = path.join(substrate, "compatibility.json");
    const healthScript = path.join(substrate, "health.py");
    await mkdir(substrate, { recursive: true });
    await writeFile(
      contract,
      `${JSON.stringify({ format: 1, substrateApi: 1, coreApi: 1, adapterApi: 1, schemaVersion: 1 }, null, 2)}\n`,
      "utf8",
    );

    const configuredEnv = isolatedEnv(home, {
      SOLARISAEL_HOUSE_CORE: core,
      SOLARISAEL_SUBSTRATE: substrate,
    });
    const configuredArgs = [...args, "--substrate", substrate];
    const missingHealth = await runAllowFailure(
      process.execPath,
      [verifyInstaller, ...configuredArgs],
      adapterRoot,
      configuredEnv,
    );
    expect(missingHealth.exitCode).not.toBe(0);
    expect(JSON.parse(missingHealth.stdout)).toMatchObject({
      mode: "degraded",
      runtimeHealth: {
        ok: false,
        state: "unhealthy",
        verdict: { configured: true, mode: "degraded" },
      },
    });

    await writeFile(
      healthScript,
      `print(${JSON.stringify(JSON.stringify({ ok: true, mode: "full", substrateApi: 1, degradedReasons: [] }))})\n`,
      "utf8",
    );
    const full = await runAllowFailure(process.execPath, [verifyInstaller, ...configuredArgs], adapterRoot, configuredEnv);
    expect(full.exitCode).toBe(0);
    expect(JSON.parse(full.stdout)).toMatchObject({
      ok: true,
      mode: "Full",
      compatibility: { ok: true },
      runtimeHealth: { ok: true, state: "healthy", verdict: { mode: "full" } },
    });

    for (const api of ["substrateApi", "coreApi", "adapterApi"]) {
      await writeFile(
        contract,
        `${JSON.stringify({ format: 1, substrateApi: 1, coreApi: 1, adapterApi: 1, [api]: 2 }, null, 2)}\n`,
        "utf8",
      );
      const mismatch = await runAllowFailure(process.execPath, [verifyInstaller, ...configuredArgs], adapterRoot, configuredEnv);
      const mismatchResult = JSON.parse(mismatch.stdout);
      expect(mismatch.exitCode).not.toBe(0);
      expect(mismatchResult.mode).toBe("degraded");
      expect(mismatchResult.checks).toContainEqual(expect.objectContaining({
        name: `${api === "substrateApi" ? "substrate" : api === "coreApi" ? "core" : "adapter"} API compatibility`,
        ok: false,
      }));
    }

    await rm(contract, { force: true });
    const missingContract = await runAllowFailure(process.execPath, [verifyInstaller, ...configuredArgs], adapterRoot, configuredEnv);
    expect(missingContract.exitCode).not.toBe(0);
    expect(JSON.parse(missingContract.stdout).mode).toBe("degraded");

    await writeFile(
      contract,
      `${JSON.stringify({ format: 1, substrateApi: 1, coreApi: 1, adapterApi: 1, schemaVersion: 1 }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      healthScript,
      `print(${JSON.stringify(JSON.stringify({ ok: false, mode: "degraded", substrateApi: 1, degradedReasons: ["database unavailable"] }))})\n`,
      "utf8",
    );
    const unhealthy = await runAllowFailure(process.execPath, [verifyInstaller, ...configuredArgs], adapterRoot, configuredEnv);
    expect(unhealthy.exitCode).not.toBe(0);
    expect(JSON.parse(unhealthy.stdout)).toMatchObject({
      mode: "degraded",
      runtimeHealth: {
        ok: false,
        state: "unhealthy",
        verdict: { degradedReasons: ["database unavailable"] },
      },
    });


    await rm(agentsPath, { force: true });
    const failure = await runAllowFailure(process.execPath, [verifyInstaller, ...args], adapterRoot, env);
    expect(failure.exitCode).not.toBe(0);
    expect(JSON.parse(failure.stdout)).toMatchObject({
      ok: false,
      checks: expect.arrayContaining([
        expect.objectContaining({ name: "host context entrypoint", ok: false }),
      ]),
    });
  });
});

