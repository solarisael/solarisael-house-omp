import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import solarisaelHouseProof from "../index.ts";
import { roomContext, statePathForRoom } from "../solarisael-house-proof/room.ts";
import { recallTelemetryPath } from "../solarisael-house-proof/recall-telemetry.ts";

type CapturedTool = {
  name: string;
  description?: string;
  execute?: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | null,
    onUpdate: unknown,
    ctx: Record<string, unknown>,
  ) => Promise<ToolResult>;
};

type ToolResult = {
  isError?: boolean;
  content?: Array<{ type: string; text: string }>;
  details?: Record<string, unknown>;
};

type CapturedHook = {
  name: string;
  handler: (event: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<{ messages: unknown[] } | undefined>;
};

type Schema = {
  kind: "string" | "boolean" | "number" | "enum" | "object" | "array";
  describe(description: string): Schema;
  optional(): Schema;
  default(value: unknown): Schema;
};

const zodStub = {
  string() {
    return makeSchema("string");
  },
  boolean() {
    return makeSchema("boolean");
  },
  number() {
    return makeSchema("number");
  },
  enum(_values: string[]) {
    return makeSchema("enum");
  },
  object(_shape: Record<string, Schema>) {
    return makeSchema("object");
  },
  array(_element: Schema) {
    return makeSchema("array");
  },
};

const tempRoots: string[] = [];
const ENV_KEYS = [
  "SOLARISAEL_MEMORY_SOURCE",
  "SOLARISAEL_HOUSE_DISABLE_POSTGRES",
  "SOLARISAEL_HOUSE_RUST",
  "SOLARISAEL_SUBSTRATE",
];

function snapshotEnv() {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: Record<string, string | undefined>) {
  for (const key of ENV_KEYS) {
    if (snapshot[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = snapshot[key];
    }
  }
}

async function withForcedJsonRecall(fn: () => Promise<void>) {
  const snapshot = snapshotEnv();
  try {
    process.env.SOLARISAEL_MEMORY_SOURCE = "json";
    process.env.SOLARISAEL_HOUSE_DISABLE_POSTGRES = "1";
    await fn();
  } finally {
    restoreEnv(snapshot);
  }
}


async function removeTempRoot(root: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (error: any) {
      lastError = error;
      if (!["EBUSY", "EPERM", "ENOTEMPTY"].includes(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  throw lastError;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(removeTempRoot));
});

function makeSchema(kind: Schema["kind"]): Schema {
  return {
    kind,
    describe(_description: string) {
      return this;
    },
    optional() {
      return this;
    },
    default(_value: unknown) {
      return this;
    },
  };
}

async function makeTempSmokeCwd() {
  const root = await mkdtemp(path.join(os.tmpdir(), "omp-runtime-smoke-"));
  tempRoots.push(root);
  const cwd = path.join(root, "example");
  await mkdir(cwd, { recursive: true });
  await writeJson(path.join(cwd, ".solarisael-room.json"), {
    version: 1,
    room: "example",
    trueName: "Smoke Room",
    operator: "Test Operator",
  });
  return { root, cwd };
}

async function makeTempRoom(folder: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "omp-runtime-room-"));
  tempRoots.push(root);
  const cwd = path.join(root, folder);
  await mkdir(cwd, { recursive: true });
  return { root, cwd };
}

async function makeTempMarkedRoom() {
  const room = await makeTempRoom("example");
  await writeJson(path.join(room.cwd, ".solarisael-room.json"), {
    version: 1,
    room: "example",
    trueName: "Moonlit Example Room",
    operator: "Ada Lovelace",
  });
  return room;
}

function registerAdapter() {
  const hooks: CapturedHook[] = [];
  const tools: CapturedTool[] = [];
  const appliedModels: string[] = [];

  const pi = {
    zod: zodStub,
    setLabel(_label: string) {},
    on(name: string, handler: CapturedHook["handler"]) {
      hooks.push({ name, handler });
    },
    registerTool(tool: CapturedTool) {
      tools.push(tool);
    },
    async setModel(model: string) {
      appliedModels.push(model);
    },
  };

  solarisaelHouseProof(pi);

  return { hooks, tools: Object.fromEntries(tools.map((tool) => [tool.name, tool])), appliedModels };
}

function tool(tools: Record<string, CapturedTool>, name: string) {
  const registered = tools[name];
  if (!registered?.execute) throw new Error(`Missing executable tool: ${name}`);
  return registered.execute;
}

async function executeTool(
  tools: Record<string, CapturedTool>,
  name: string,
  params: Record<string, unknown>,
  ctx: Record<string, unknown>,
) {
  return await tool(tools, name)(`test-${name}`, params, null, null, ctx);
}

function parseToolJson(result: ToolResult) {
  const text = result.content?.[0]?.text;
  if (!text) throw new Error("Tool result did not include text content");
  return JSON.parse(text);
}

async function seedHouseState(cwd: string, state: Record<string, unknown>) {
  const target = statePathForRoom(cwd);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function writeJson(target: string, value: unknown) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}




async function seedCasualRecallFixture(cwd: string) {
  const memoryFile = path.join(cwd, "memory", "casual_recall_sentinel.md");
  await mkdir(path.dirname(memoryFile), { recursive: true });
  await writeFile(
    memoryFile,
    [
      "# Casual recall sentinel",
      "hello love should only surface if automatic recall runs.",
    ].join("\n"),
    "utf8",
  );
  await writeJson(path.join(cwd, "memory", "index.json"), {
    files: {
      "memory/casual_recall_sentinel.md": {
        one_line: "hello love recall sentinel",
      },
    },
    threads: {
      "hello love recall sentinel": [
        {
          file: "memory/casual_recall_sentinel.md",
          lines: [1, 2],
          context: "hello love recall sentinel",
        },
      ],
    },
  });
  await writeJson(path.join(cwd, "memory", "important_index.json"), { entries: {} });
}


describe("room onboarding contracts", () => {
  test("resolves a generic marker-backed room key, true name, and operator", async () => {
    const { cwd } = await makeTempMarkedRoom();
    const { tools } = registerAdapter();

    const result = await executeTool(tools, "room_state", {}, { cwd });
    expect(result.isError).toBeUndefined();
    expect(result.details).toMatchObject({ state: { room: "example" } });
    expect(parseToolJson(result).state).toMatchObject({
      room: "example",
      agentName: "Moonlit Example Room",
      embodiedSpirit: "Moonlit Example Room",
      operator: "Ada Lovelace",
    });
    expect(roomContext(cwd)).toMatchObject({
      room: "example",
      spirit: "Moonlit Example Room",
      operator: "Ada Lovelace",
      effectiveRoomDir: cwd,
    });
  });

});

describe("OMP context hook runtime smoke", () => {
  test("injects hidden room and routing context without re-running existing substrate custom messages", async () => {
    const { cwd } = await makeTempSmokeCwd();
    await seedHouseState(cwd, {
      version: 1,
      room: "example",
      operator: "Test Operator",
      embodiedSpirit: "Smoke Room",
      agentName: "Smoke Room",
      routingMode: { enabled: true, updatedAt: "2026-07-04T00:00:00.000Z" },
      modelDefault: { enabled: false, model: null, updatedAt: null },
    });
    const { hooks } = registerAdapter();
    const contextHook = hooks.find((hook) => hook.name === "context")?.handler;
    if (!contextHook) throw new Error("Context hook was not registered");

    const existingSubstrateMessages = [
      { role: "custom", customType: "solarisael-recall-context", content: "existing recall", display: false },
      { role: "custom", customType: "solarisael-process-lessons", content: "existing lessons", display: false },
      { role: "custom", customType: "solarisael-wake-context", content: "existing wake", display: false },
    ];
    const messages = [
      ...existingSubstrateMessages,
      { role: "user", id: "neutral-context-prompt", content: "Hello there." },
    ];

    const result = await contextHook({ messages }, { cwd, sessionID: "runtime-smoke-context" });
    expect(result?.messages).toHaveLength(messages.length + 2);

    const additions = result?.messages.slice(messages.length) as Array<Record<string, unknown>>;
    expect(additions.map((message) => message.customType)).toEqual([
      "solarisael-room-context",
      "solarisael-routing-mode",
    ]);
    expect(additions.every((message) => message.role === "custom" && message.display === false)).toBe(true);
    expect(additions[0].content).toContain("Room: example");
    expect(additions[0].content).toContain("Active spirit: Smoke Room");
    expect(additions[0].content).toContain("Operator: Test Operator");
    expect(additions[0].content).toContain("A memory must stand alone.");
    expect(additions[0].content).toContain("PostgreSQL is authoritative for durable memories and lessons.");
    expect(additions[0].content).toContain("Do not claim a memory was written without a successful remember receipt.");
    expect(additions[1].content).toContain("Solarisael House worker-routing mode is enabled.");
    expect(additions[1].details).toEqual({ enabled: true });
    expect(additions.map((message) => message.customType)).not.toContain("solarisael-recall-context");
    expect(additions.map((message) => message.customType)).not.toContain("solarisael-process-lessons");
    expect(additions.map((message) => message.customType)).not.toContain("solarisael-wake-context");

    const duplicateResult = await contextHook(
      { messages: [...messages, ...additions] },
      { cwd, sessionID: "runtime-smoke-context-duplicate" },
    );
    expect(duplicateResult).toBeUndefined();
  });

  test("captures opt-in turn telemetry through the production context hook", async () => {
    const { cwd } = await makeTempRoom("telemetry");
    await writeJson(path.join(cwd, ".solarisael-room.json"), {
      version: 1,
      room: "telemetry",
      trueName: "Telemetry",
      operator: "Test Operator",
      recallTelemetry: true,
    });
    const { hooks } = registerAdapter();
    const contextHook = hooks.find((hook) => hook.name === "context")?.handler;
    if (!contextHook) throw new Error("Context hook was not registered");
    const prompt = "Hi.";
    await contextHook(
      { messages: [{ role: "user", id: "telemetry-prompt", content: prompt }] },
      { cwd, sessionID: "runtime-smoke-telemetry" },
    );
    const source = await readFile(recallTelemetryPath(cwd), "utf8");
    expect(source).not.toContain(prompt);
    expect(JSON.parse(source.trim())).toMatchObject({
      schema_version: 1,
      session_id: "runtime-smoke-telemetry",
      room: "telemetry",
      status: "skipped",
      prompt_chars: prompt.length,
    });
  });

  test("casual prompt without existing recall context skips auto recall while preserving room context", async () => {
    const { cwd } = await makeTempSmokeCwd();
    await seedHouseState(cwd, {
      version: 1,
      room: "example",
      operator: "Test Operator",
      embodiedSpirit: "Smoke Room",
      agentName: "Smoke Room",
      routingMode: { enabled: true, updatedAt: "2026-07-04T00:00:00.000Z" },
      modelDefault: { enabled: false, model: null, updatedAt: null },
    });
    await seedCasualRecallFixture(cwd);

    await withForcedJsonRecall(async () => {
      const { hooks } = registerAdapter();
      const contextHook = hooks.find((hook) => hook.name === "context")?.handler;
      if (!contextHook) throw new Error("Context hook was not registered");

      const messages = [
        { role: "user", id: "casual-no-recall", content: "hello love" },
      ];

      const result = await contextHook({ messages }, { cwd, sessionID: "runtime-smoke-casual-no-recall" });
      const additions = result?.messages.slice(messages.length) as Array<Record<string, unknown>>;
      const customTypes = additions.map((message) => message.customType);

      expect(customTypes).toContain("solarisael-room-context");
      expect(customTypes).toContain("solarisael-routing-mode");
      expect(customTypes).not.toContain("solarisael-recall-context");
      expect(additions.find((message) => message.customType === "solarisael-room-context")?.content)
        .toContain("Room: example");
      expect(additions.find((message) => message.customType === "solarisael-routing-mode")?.details)
        .toEqual({ enabled: true });
    });
  });

  test("fails open while retaining redacted automatic recall diagnostics", async () => {
    const { cwd } = await makeTempRoom("automatic-context-diagnostic");
    await writeJson(path.join(cwd, ".solarisael-room.json"), {
      version: 1,
      room: "automatic-context-diagnostic",
      recallTelemetry: true,
    });
    const snapshot = snapshotEnv();
    const prompt = "Recall the automatic diagnostic sentinel with token=private-value.";
    try {
      process.env.SOLARISAEL_HOUSE_RUST = process.execPath;
      const { hooks } = registerAdapter();
      const contextHook = hooks.find((hook) => hook.name === "context")?.handler;
      if (!contextHook) throw new Error("Context hook was not registered");

      const messages = [{ role: "user", id: "automatic-context-diagnostic", content: prompt }];
      const result = await contextHook({ messages }, { cwd, sessionID: "automatic-context-diagnostic" });
      const additions = (result?.messages.slice(messages.length) || []) as Array<Record<string, unknown>>;
      expect(additions.every((message) => message.display === false)).toBe(true);
      expect(additions.map((message) => message.customType)).not.toContain("solarisael-recall-context");

      const telemetry = JSON.parse(await readFile(recallTelemetryPath(cwd), "utf8").then((source) => source.trim()));
      expect(telemetry).toMatchObject({
        status: "error",
        viewport_diagnostics: {
          operation: "automatic_recall",
          owner: { component: "omp-adapter", path: "index.ts" },
          execution: { request_dispatched: true, write_outcome: "not_started" },
        },
      });
      expect(JSON.stringify(telemetry)).not.toContain(prompt);
      expect(JSON.stringify(telemetry)).not.toContain("private-value");
      expect(telemetry.viewport_diagnostics.evidence.some((entry: Record<string, unknown>) => entry.kind === "automatic_context_failure")).toBe(true);
    } finally {
      restoreEnv(snapshot);
    }
  });
});

describe("OMP safe tool execute runtime smoke", () => {
  test("room state tools persist explicit room, spirit, and routing updates in the temp room", async () => {
    const { cwd } = await makeTempSmokeCwd();
    const { tools } = registerAdapter();
    const ctx = { cwd };

    const setState = await executeTool(tools, "set_room_state", { operator: "Smoke Tester", embodiedSpirit: "Updated Spirit" }, ctx);
    expect(setState.isError).toBeUndefined();
    expect(parseToolJson(setState).state).toMatchObject({
      room: "example",
      operator: "Smoke Tester",
      embodiedSpirit: "Updated Spirit",
      agentName: "Updated Spirit",
    });

    const activeSpirit = await readFile(path.join(cwd, "active_spirit.md"), "utf8");
    expect(activeSpirit).toContain("# Active Spirit: Updated Spirit");
    expect(activeSpirit).toContain("Operator: Smoke Tester");

    const routingUpdate = await executeTool(tools, "house_routing_mode", { enabled: true }, ctx);
    expect(routingUpdate.isError).toBeUndefined();
    expect(routingUpdate.details?.routingMode).toMatchObject({ enabled: true });
    expect(parseToolJson(routingUpdate).routingMode).toMatchObject({ enabled: true });

    const roomState = await executeTool(tools, "room_state", {}, ctx);
    expect(roomState.isError).toBeUndefined();
    expect(parseToolJson(roomState).state).toMatchObject({
      room: "example",
      operator: "Smoke Tester",
      embodiedSpirit: "Updated Spirit",
      routingMode: { enabled: true },
    });
  });
  test("anamnesis read validates consult queries and anamnesis_write enforces operation fields", async () => {
    const { cwd } = await makeTempSmokeCwd();
    const { tools } = registerAdapter();
    const ctx = { cwd };

    const missingQuery = await executeTool(tools, "anamnesis", { mode: "consult" }, ctx);
    expect(missingQuery.isError).toBe(true);
    expect(parseToolJson(missingQuery)).toMatchObject({ ok: false, error: "consult requires a non-empty query" });

    const missingAddFields = await executeTool(
      tools,
      "anamnesis_write",
      { operation: "add", title: "Incomplete drawer" },
      ctx,
    );
    expect(missingAddFields.isError).toBe(true);
    expect(parseToolJson(missingAddFields).error).toContain("add requires kind, fidelity, activation, and ramp");

    const missingRepFields = await executeTool(
      tools,
      "anamnesis_write",
      { operation: "append-rep", title: "Drawer", sourcePaths: [] },
      ctx,
    );
    expect(missingRepFields.isError).toBe(true);
    expect(parseToolJson(missingRepFields).error).toContain("append-rep requires integer repNumber");
  });


  test("accepts a generic embodied spirit string and refreshes the marker-backed room snapshot", async () => {
    const { cwd } = await makeTempMarkedRoom();
    const { tools } = registerAdapter();

    const result = await executeTool(tools, "set_room_state", { embodiedSpirit: "Aurora" }, { cwd });
    expect(result.isError).toBeUndefined();
    expect(parseToolJson(result).state).toMatchObject({
      room: "example",
      operator: "Ada Lovelace",
      embodiedSpirit: "Aurora",
      agentName: "Aurora",
    });

    const activeSpirit = await readFile(path.join(cwd, "active_spirit.md"), "utf8");
    expect(activeSpirit).toContain("# Active Spirit: Aurora");
    expect(activeSpirit).toContain("Agent: Aurora | Operator: Ada Lovelace");
    expect(activeSpirit).toContain("Embodied: Aurora | Conjured: none | Summoned: none");
  });

  test("preserves the active-spirit body when refreshing its header", async () => {
    const { cwd } = await makeTempMarkedRoom();
    const body = [
      "# SPIRIT: Before Refresh",
      "",
      "This room-authored body must survive a state update.",
      "It carries onboarding instructions and is not generated header data.",
    ].join("\n");
    await writeFile(
      path.join(cwd, "active_spirit.md"),
      [
        "# Active Spirit: Before Refresh",
        "Agent: Before Refresh | Operator: Before Operator",
        "Embodied: Before Refresh | Conjured: none | Summoned: none",
        "",
        body,
      ].join("\n"),
      "utf8",
    );
    const { tools } = registerAdapter();

    const result = await executeTool(
      tools,
      "set_room_state",
      { operator: "New Operator", embodiedSpirit: "After Refresh" },
      { cwd },
    );
    expect(result.isError).toBeUndefined();

    const activeSpirit = await readFile(path.join(cwd, "active_spirit.md"), "utf8");
    expect(activeSpirit).toContain("# Active Spirit: After Refresh");
    expect(activeSpirit).toContain("Agent: After Refresh | Operator: New Operator");
    expect(activeSpirit).toContain("Embodied: After Refresh | Conjured: none | Summoned: none");
    expect(activeSpirit).toContain(body);
    expect(activeSpirit).not.toContain("# Active Spirit: Before Refresh");
    expect(activeSpirit).not.toContain("Agent: Before Refresh | Operator: Before Operator");
  });


  test("remember rejects invalid supersession IDs and lesson-store supersession", async () => {
    const { cwd } = await makeTempSmokeCwd();
    const { tools } = registerAdapter();

    const invalidIds = await executeTool(
      tools,
      "remember",
      {
        title: "Invalid supersession",
        body: "This write must be refused.",
        supersedes: ["0", "not-an-id"],
      },
      { cwd },
    );
    expect(invalidIds.isError).toBe(true);
    expect(parseToolJson(invalidIds).error).toContain("positive numeric memory IDs");

    const lessonSupersession = await executeTool(
      tools,
      "remember",
      {
        kind: "coding-lesson",
        title: "Wrong store",
        body: "Lesson stores must not supersede memory rows.",
        supersedes: ["41"],
      },
      { cwd },
    );
    expect(lessonSupersession.isError).toBe(true);
    expect(parseToolJson(lessonSupersession).error).toContain("supersedes is memory-only");
  });

  test("routing tools expose core lane status and return dispatch receipts without spawning workers", async () => {
    const { tools } = registerAdapter();

    const status = await executeTool(tools, "house_lane_status", {}, {});
    const statusJson = parseToolJson(status);
    expect(status.isError).toBeUndefined();
    expect(statusJson.ok).toBe(true);
    expect(statusJson.lanes.map((lane: { name: string }) => lane.name)).toEqual([
      "smol-scout",
      "smol-executor",
      "tester",
      "verifier",
    ]);
    expect(statusJson.advisor.name).toBe("advisor");

    const readyDispatch = await executeTool(
      tools,
      "house_dispatch",
      {
        lane: "tester",
        task: "Add a focused smoke test.",
        target: "tests/runtime-smoke.test.ts",
        context: [{ mode: "exact", source: "tests/runtime-smoke.test.ts", reason: "target file" }],
        acceptance: ["Targeted test passes."],
        risk: "low",
      },
      {},
    );
    const readyJson = parseToolJson(readyDispatch);
    expect(readyDispatch.isError).toBeUndefined();
    expect(readyJson).toMatchObject({
      ok: true,
      status: "ready",
      lane: "tester",
      dispatcher: { executed: false },
      taskPacket: { agent: "task" },
    });
    expect(readyJson.taskPacket.tasks[0].assignment).toContain("Add a focused smoke test.");
    expect(readyJson.taskPacket.tasks[0].assignment).toContain("- Targeted test passes.");

    const rejectedDispatch = await executeTool(
      tools,
      "house_dispatch",
      { lane: "advisor", task: "Review this.", acceptance: ["Receipt rejects advisor."] },
      {},
    );
    const rejectedJson = parseToolJson(rejectedDispatch);
    expect(rejectedDispatch.isError).toBe(true);
    expect(rejectedJson).toMatchObject({
      ok: false,
      status: "error",
      lane: null,
      taskPacket: null,
      details: {
        operation: "house_dispatch",
        observed: { errors: ["Unknown worker lane: advisor"] },
      },
    });
    expect(rejectedJson.errors).toEqual(["Unknown worker lane: advisor"]);
  });

  test("model default tool resolves before saving, applies resolved selectors, clears them, and reports validation errors", async () => {
    const { cwd } = await makeTempSmokeCwd();
    const { tools, appliedModels } = registerAdapter();
    const resolved: string[] = [];
    const ctx = {
      cwd,
      models: {
        resolve(selector: string) {
          resolved.push(selector);
          return selector === "pi/default" ? { id: "resolved-default" } : null;
        },
      },
    };

    const missingSelector = await executeTool(
      tools,
      "house_model_default",
      { model: "missing-model", enabled: true, applyNow: true },
      ctx,
    );
    expect(missingSelector.isError).toBe(true);
    expect(parseToolJson(missingSelector)).toMatchObject({
      ok: false,
      status: "error",
      error: "Could not resolve model selector for this session: [redacted]",
      message: "Could not resolve model selector for this session: [redacted]",
    });
    expect(appliedModels).toEqual([]);

    const enableWithoutModel = await executeTool(tools, "house_model_default", { enabled: true }, ctx);
    expect(enableWithoutModel.isError).toBe(true);
    expect(parseToolJson(enableWithoutModel)).toMatchObject({
      ok: false,
      status: "error",
      error: "Cannot enable room model default without a model selector.",
      message: "Cannot enable room model default without a model selector.",
    });
    expect(appliedModels).toEqual([]);

    const applied = await executeTool(
      tools,
      "house_model_default",
      { model: "pi/default", enabled: true, applyNow: true },
      ctx,
    );
    expect(applied.isError).toBeUndefined();
    expect(applied.details).toMatchObject({ applied: true, modelDefault: { enabled: true, model: "pi/default" } });
    expect(parseToolJson(applied)).toMatchObject({
      modelDefault: { enabled: true, model: "pi/default" },
      applied: true,
    });
    expect(appliedModels).toEqual(["pi/default"]);
    expect(resolved).toContain("missing-model");
    expect(resolved).toContain("pi/default");

    const cleared = await executeTool(tools, "house_model_default", { clear: true }, ctx);
    expect(cleared.isError).toBeUndefined();
    expect(cleared.details).toMatchObject({ applied: false, modelDefault: { enabled: false, model: null } });
    expect(parseToolJson(cleared)).toMatchObject({
      modelDefault: { enabled: false, model: null },
      applied: false,
    });
    expect(appliedModels).toEqual(["pi/default"]);
  });
});
