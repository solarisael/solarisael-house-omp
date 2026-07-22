import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JsonObject, RustJsonlTransport, RustTransportError } from "../rust-transport.ts";

const fixture = `
const mode = process.argv[2];
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (process.env.RECORD_FILE) require("node:fs").appendFileSync(process.env.RECORD_FILE, line + "\\n");
  if (mode === "success") process.stdout.write(JSON.stringify({ protocol: 1, id: request.id, result: { echoed: request.params.value } }) + "\\n");
  else if (mode === "delayed") setTimeout(() => process.stdout.write(JSON.stringify({ protocol: 1, id: request.id, result: { echoed: request.params.value } }) + "\\n"), 40);
  else if (mode === "error") { process.stderr.write("diagnostic-too-long\\n"); process.stdout.write(JSON.stringify({ protocol: 1, id: request.id, error: { code: "NOPE", message: "nope", retryable: true, details: { value: 3 } } }) + "\\n"); }
  else if (mode === "malformed") process.stdout.write("not-json\\n");
  else if (mode === "both") process.stdout.write(JSON.stringify({ protocol: 1, id: request.id, result: true, error: null }) + "\\n");
  else if (mode === "neither") process.stdout.write(JSON.stringify({ protocol: 1, id: request.id }) + "\\n");
  else if (mode === "oversized") process.stdout.write("x".repeat(1024 * 1024 + 1));
  else if (mode === "duplicate") { const response = JSON.stringify({ protocol: 1, id: request.id, result: true }) + "\\n"; process.stdout.write(response + response); }
  else if (mode === "out-of-order") { setTimeout(() => process.stdout.write(JSON.stringify({ protocol: 1, id: request.id, result: request.params.value }) + "\\n"), request.params.delay); }
  else if (mode === "exit") process.exit(0);
  else if (mode === "stderr") { process.stderr.write("diagnostic\\n"); }
});
`;

async function withFixture<T>(mode: string, fn: (executable: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "house-omp-transport-"));
  const file = path.join(dir, "fixture.cjs");
  await writeFile(file, fixture, "utf8");
  try { return await fn(file); } finally { await rm(dir, { recursive: true, force: true }); }
}
function transport(executable: string, mode: string) {
  return new RustJsonlTransport({ executable: process.execPath, args: [executable, mode] });
}

describe("Rust JSONL transport", () => {
  test("returns successful result", async () => withFixture("success", async (file) => {
    const client = transport(file, "success");
    await expect(client.request("remember", { value: "ok" })).resolves.toEqual({ echoed: "ok" });
    client.close();
  }));

  test("propagates structured errors and bounded stderr", async () => withFixture("error", async (file) => {
    const client = new RustJsonlTransport({ executable: process.execPath, args: [file, "error"], stderrLimitBytes: 8 });
    const promise = client.request("remember", { value: 1 });
    const error = await promise.catch((e) => e);
    expect(error).toMatchObject({ code: "NOPE", message: "nope", retryable: true, details: { value: 3 } });
    expect(error.stderr).toBe("diagnost");
    expect(error instanceof RustTransportError).toBe(true);
    client.close();
  }));

  test("rejects malformed output and all pending calls", async () => withFixture("malformed", async (file) => {
    const client = transport(file, "malformed");
    await expect(client.request("remember", {})).rejects.toThrow("malformed JSON");
    await expect(client.request("remember", {})).rejects.toThrow("malformed JSON");
  }));
  test("rejects matched malformed valid envelopes without orphaning", async () => {
    for (const mode of ["both", "neither"]) await withFixture(mode, async (file) => {
      const client = transport(file, mode);
      await expect(client.request("remember", {})).rejects.toThrow("exactly one");
      await expect(client.request("remember", {})).rejects.toThrow("exactly one");
    });
  });

  test("isolates circular local serialization failures", async () => withFixture("out-of-order", async (file) => {
    const client = transport(file, "out-of-order");
    const first = client.request("remember", { value: "ok", delay: 10 });
    const circular: JsonObject = {};
    circular.self = circular;
    await expect(client.request("remember", circular)).rejects.toThrow();
    await expect(first).resolves.toEqual("ok");
    client.close();
  }));

  test("rejects oversized unterminated output", async () => withFixture("oversized", async (file) => {
    const client = transport(file, "oversized");
    await expect(client.request("remember", {})).rejects.toThrow("exceeds maximum");
  }));

  test("validates timeout before spawning and rejects overflow", async () => withFixture("success", async (file) => {
    const client = transport(file, "success");
    await expect(client.request("remember", {}, { timeoutMs: -1 })).rejects.toThrow("timeoutMs");
    await expect(client.request("remember", {}, { timeoutMs: Number.MAX_SAFE_INTEGER })).rejects.toThrow("timeoutMs");
    await expect(client.request("remember", { value: "still-works" })).resolves.toEqual({ echoed: "still-works" });
    client.close();
  }));

  test("pre-aborted request with timeout does not leave a timer or child", async () => withFixture("success", async (file) => {
    const client = transport(file, "success");
    const controller = new AbortController();
    controller.abort();
    await expect(client.request("remember", {}, { signal: controller.signal, timeoutMs: 2_147_483_647 })).rejects.toThrow("cancelled");
    await expect(client.request("remember", {})).rejects.toThrow("cancelled");
  }));

  test("definitive requests ignore post-dispatch abort but honor pre-abort", async () => withFixture("delayed", async (file) => {
    const recordFile = path.join(os.tmpdir(), `house-omp-transport-${Date.now()}-${Math.random()}.log`);
    const client = new RustJsonlTransport({
      executable: process.execPath,
      args: [file, "delayed"],
      env: { RECORD_FILE: recordFile },
    });
    const controller = new AbortController();
    const response = client.request("remember", { value: "committed" }, {
      signal: controller.signal,
      timeoutMs: 1,
      settleDefinitively: true,
    });
    setTimeout(() => controller.abort(), 5);
    await expect(response).resolves.toEqual({ echoed: "committed" });
    await expect(client.request("remember", { value: "still-alive" }, { settleDefinitively: true })).resolves.toEqual({ echoed: "still-alive" });

    const preAborted = new AbortController();
    preAborted.abort();
    await expect(client.request("remember", { value: "not-sent" }, {
      signal: preAborted.signal,
      settleDefinitively: true,
    })).rejects.toThrow("cancelled");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const records = await Bun.file(recordFile).exists() ? await Bun.file(recordFile).text() : "";
    expect(records).not.toContain("not-sent");
    client.close();
    await rm(recordFile, { force: true });
  }));

  test("bounds concurrent pending requests", async () => withFixture("out-of-order", async (file) => {
    const client = transport(file, "out-of-order");
    const requests = Array.from({ length: 1025 }, (_, index) => client.request("remember", { value: index, delay: 1000 }));
    const outcomes = await Promise.allSettled(requests);
    expect(outcomes.some((outcome) => outcome.status === "rejected" && String((outcome as PromiseRejectedResult).reason.message).includes("limit"))).toBe(true);
    client.close();
  }));

  test("cancellation and timeout make the owned transport unusable", async () => withFixture("success", async (file) => {
    const client = transport(file, "success");
    const controller = new AbortController();
    controller.abort();
    await expect(client.request("remember", {}, { signal: controller.signal })).rejects.toThrow("cancelled");
    await expect(client.request("remember", {})).rejects.toThrow("cancelled");

    const timeoutClient = transport(file, "success");
    await expect(timeoutClient.request("remember", {}, { timeoutMs: 1 })).rejects.toThrow("timed out");
    await expect(timeoutClient.request("remember", {})).rejects.toThrow("timed out");
  }));

  test("correlates concurrent out-of-order responses and rejects duplicates", async () => withFixture("out-of-order", async (file) => {
    const client = transport(file, "out-of-order");
    const first = client.request("remember", { value: "slow", delay: 25 });
    const second = client.request("remember", { value: "fast", delay: 1 });
    await expect(Promise.all([first, second])).resolves.toEqual(["slow", "fast"]);
    client.close();
  }));

  test("child exit rejects pending requests", async () => withFixture("exit", async (file) => {
    const client = transport(file, "exit");
    await expect(client.request("remember", {})).rejects.toThrow("child exited");
    await expect(client.request("remember", {})).rejects.toThrow("child exited");
  }));

  test("duplicate response IDs make transport unusable", async () => withFixture("duplicate", async (file) => {
    const client = transport(file, "duplicate");
    const outcomes = await Promise.allSettled([
      client.request("remember", {}),
      client.request("remember", {}),
    ]);
    expect(outcomes[0]).toMatchObject({ status: "fulfilled", value: true });
    expect(outcomes[1]).toMatchObject({ status: "rejected" });
    expect((outcomes[1] as PromiseRejectedResult).reason.message).toContain("unknown or duplicate");
  }));
});
