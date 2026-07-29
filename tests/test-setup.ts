import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ISOLATED_POSTGRES_GATE = "SOLARISAEL_I_UNDERSTAND_THIS_IS_AN_ISOLATED_POSTGRES_TEST";
const OLD_POSTGRES_GATE = "SOLARISAEL_OMP_POSTGRES_TEST";
const LIVE_CONFIGURATION_KEYS = [
  "SOLARISAEL_HOUSE_RUST",
  "SOLARISAEL_SUBSTRATE",
  "SOLARISAEL_GIGA_ENABLED",
  "SOLARISAEL_SUBSTRATE_TEST_DATABASE_URL",
  "DATABASE_URL",
  "PGHOST",
  "PGPORT",
  "PGDATABASE",
  "PGUSER",
  "PGPASSWORD",
] as const;

function configured(key: string): boolean {
  return typeof process.env[key] === "string" && process.env[key]!.trim().length > 0;
}

function observedValue(key: string): string {
  const value = process.env[key] ?? "";
  if (/PASSWORD|DATABASE_URL|PGHOST|PGPORT|PGDATABASE|PGUSER/i.test(key)) return "[REDACTED]";
  return value.replace(/:\/\/[^/\s:@]+:[^/\s@]+@/g, "://[REDACTED]@");
}

function fail(message: string): never {
  throw new Error(`${message} Fix: clear the listed variables and rerun bun test.`);
}

function dotenvValue(root: string, key: string): string | null {
  const file = path.join(root, ".env");
  if (!existsSync(file)) return null;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)\\s*$`));
    if (match) return match[1].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return null;
}

function databaseIdentity(value: string): string | null {
  try {
    const url = new URL(value);
    return `${url.hostname.toLowerCase()}:${url.port || "5432"}${url.pathname.replace(/\/+$/, "") || "/"}`;
  } catch {
    return null;
  }
}

function dotenvDatabaseIdentity(root: string): string | null {
  const url = dotenvValue(root, "DATABASE_URL");
  if (url) return databaseIdentity(url);
  const host = dotenvValue(root, "PGHOST");
  const database = dotenvValue(root, "PGDATABASE");
  if (!host || !database) return null;
  return `${host.toLowerCase()}:${dotenvValue(root, "PGPORT") || "5432"}/${database}`;
}

function assertIsolatedPostgresTarget(): void {
  const substrate = process.env.SOLARISAEL_SUBSTRATE?.trim();
  const testDatabase = process.env.SOLARISAEL_SUBSTRATE_TEST_DATABASE_URL?.trim();
  const rust = process.env.SOLARISAEL_HOUSE_RUST?.trim();
  if (!substrate || !testDatabase || !rust) {
    fail(
      `${ISOLATED_POSTGRES_GATE}=1 requires SOLARISAEL_SUBSTRATE, SOLARISAEL_HOUSE_RUST, `
      + "and SOLARISAEL_SUBSTRATE_TEST_DATABASE_URL",
    );
  }
  const productionDatabaseIdentity = dotenvDatabaseIdentity(substrate);
  if (!productionDatabaseIdentity) {
    fail("The isolated PostgreSQL target has no complete .env database identity for comparison");
  }
  if (databaseIdentity(testDatabase) === null) {
    fail(`SOLARISAEL_SUBSTRATE_TEST_DATABASE_URL=${observedValue("SOLARISAEL_SUBSTRATE_TEST_DATABASE_URL")} is not a valid PostgreSQL DSN`);
  }
  if (databaseIdentity(testDatabase) === productionDatabaseIdentity) {
    fail(
      `SOLARISAEL_SUBSTRATE_TEST_DATABASE_URL=${observedValue("SOLARISAEL_SUBSTRATE_TEST_DATABASE_URL")} `
      + "matches the database identity in the configured substrate .env",
    );
  }
  if (process.env.SOLARISAEL_HOUSE_DISABLE_POSTGRES === "1") {
    fail("SOLARISAEL_HOUSE_DISABLE_POSTGRES=1 disables the isolated PostgreSQL test target");
  }
}

function assertNoLiveConfiguration(): void {
  if (configured(OLD_POSTGRES_GATE)) {
    fail(
      `${OLD_POSTGRES_GATE}=${observedValue(OLD_POSTGRES_GATE)} is no longer accepted; `
      + `use ${ISOLATED_POSTGRES_GATE}=1 with an explicit isolated test DSN`,
    );
  }
  const isolatedPostgres = process.env[ISOLATED_POSTGRES_GATE] === "1";
  const violations = LIVE_CONFIGURATION_KEYS.filter((key) => {
    if (isolatedPostgres && ["SOLARISAEL_HOUSE_RUST", "SOLARISAEL_SUBSTRATE", "SOLARISAEL_SUBSTRATE_TEST_DATABASE_URL"].includes(key)) return false;
    if (key === "SOLARISAEL_GIGA_ENABLED") return process.env[key] === "1";
    return configured(key);
  });
  if (violations.length > 0) {
    const observed = violations.map((key) => `${key}=${observedValue(key)}`).join(", ");
    fail(`Refusing to run OMP tests with live substrate configuration: ${observed}.`);
  }
  if (isolatedPostgres) assertIsolatedPostgresTarget();
}

assertNoLiveConfiguration();

process.env.SOLARISAEL_GIGA_ENABLED = "0";

if (process.env[ISOLATED_POSTGRES_GATE] === "1") {
  process.env.SOLARISAEL_HOUSE_DISABLE_POSTGRES = "0";
  delete process.env.SOLARISAEL_MEMORY_SOURCE;
} else {
  // Bun itself is a valid inert child for tests that exercise enabled-GIGA
  // validation; unlike the production binary it cannot open the substrate.
  process.env.SOLARISAEL_HOUSE_RUST = process.execPath;
  process.env.SOLARISAEL_HOUSE_DISABLE_POSTGRES = "1";
  process.env.SOLARISAEL_MEMORY_SOURCE = "json";
}
