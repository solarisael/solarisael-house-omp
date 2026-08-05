import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import path from "node:path";

async function fileSha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

const versionArgument = process.argv[2];
const assetArgument = process.argv[3];
const outputArgument = process.argv[4] || "release-manifest.json";
const channel = process.argv[5] || "stable";
const repository = process.argv[6] || "solarisael/solarisael-house-omp";
const requiredSchemaVersion = Number(process.argv[7] || "10");

if (!versionArgument || !assetArgument || !["stable", "beta", "experimental"].includes(channel)) {
  throw new Error("Usage: build-release-manifest.ts VERSION ASSET [OUTPUT] [stable|beta|experimental] [OWNER/REPO] [REQUIRED_SCHEMA_VERSION]");
}
if (!Number.isSafeInteger(requiredSchemaVersion) || requiredSchemaVersion < 0) {
  throw new Error("REQUIRED_SCHEMA_VERSION must be a non-negative integer");
}
const version = versionArgument.replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`invalid semantic version: ${versionArgument}`);
const prerelease = version.split("-", 2)[1] || "";
if (channel === "stable" && prerelease) throw new Error("stable releases cannot use a prerelease version");
if (channel === "beta" && !/^beta(?:[.+-]|$)/i.test(prerelease)) throw new Error("beta releases require a -beta version");
if (channel === "experimental" && !/^(?:experimental|exp)(?:[.+-]|$)/i.test(prerelease)) throw new Error("experimental releases require an -experimental or -exp version");
const asset = path.resolve(assetArgument);
const details = await stat(asset);
if (!details.isFile()) throw new Error(`release asset is not a regular file: ${asset}`);
const sha256 = await fileSha256(asset);
const platform = process.platform === "win32" && process.arch === "x64"
  ? "windows-x64"
  : process.platform === "linux" && process.arch === "x64"
    ? "linux-x64"
    : process.platform === "linux" && process.arch === "arm64"
      ? "linux-arm64"
      : null;
if (!platform) throw new Error(`unsupported release platform: ${process.platform}-${process.arch}`);
const manifest = {
  schemaVersion: 1,
  version,
  tag: `v${version}`,
  channel,
  repository,
  requiredSchemaVersion,
  assets: [{
    platform,
    name: path.basename(asset),
    sha256,
    size: details.size,
  }],
};
await writeFile(path.resolve(outputArgument), JSON.stringify(manifest, null, 2) + "\n", "utf8");
console.log(path.resolve(outputArgument));
