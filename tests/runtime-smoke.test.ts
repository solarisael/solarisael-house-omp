import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import solarisaelHouseProof from "../index.ts";
import { roomContext, statePathForRoom } from "../solarisael-house-proof/room.ts";

type CapturedTool = {
  name: string;
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


afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  })));
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

async function makeTempKintsuCwd() {
  const root = await mkdtemp(path.join(os.tmpdir(), "omp-runtime-smoke-"));
  tempRoots.push(root);
  const cwd = path.join(root, "kintsu");
  await mkdir(cwd, { recursive: true });
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
async function makeFakeSubstrate() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "omp-fake-substrate-"));
  tempRoots.push(dir);

  await writeFile(
    path.join(dir, "record_memory.py"),
    String.raw`import argparse
import json
import sys
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--room", required=True)
parser.add_argument("--type", default="session")
parser.add_argument("--title", required=True)
parser.add_argument("--source-path", required=True)
parser.add_argument("--body-stdin", action="store_true")
parser.add_argument("--thread", action="append", default=[])
parser.add_argument("--supersedes", action="append", default=[])
parser.add_argument("--no-backup", action="store_true")
args = parser.parse_args()

base = Path(__file__).resolve().parent
records_path = base / "records.jsonl"
record_id = 1
if records_path.exists():
    record_id += sum(1 for line in records_path.read_text(encoding="utf-8").splitlines() if line.strip())

record = {
    "id": record_id,
    "room": args.room,
    "type": args.type,
    "title": args.title,
    "source_path": args.source_path,
    "body": sys.stdin.read() if args.body_stdin else "",
    "threads": args.thread,
    "supersedes": args.supersedes,
    "backup": not args.no_backup,
    "no_backup": args.no_backup,
}
with records_path.open("a", encoding="utf-8") as handle:
    handle.write(json.dumps(record, sort_keys=True) + "\n")

if args.type == "paper-boat":
    (base / "latest_paper_boat.json").write_text(
        json.dumps({
            "found": True,
            "room": args.room,
            "title": args.title,
            "body": record["body"],
            "source_path": args.source_path,
        }, sort_keys=True),
        encoding="utf-8",
    )

print(f"recorded room={args.room} type={args.type} id={record_id}")
`,
    "utf8",
  );
  await writeFile(
    path.join(dir, "catch_boat.py"),
    String.raw`import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--room", required=True)
args = parser.parse_args()

latest_path = Path(__file__).resolve().parent / "latest_paper_boat.json"
if not latest_path.exists():
    print(json.dumps({"found": False}))
else:
    latest = json.loads(latest_path.read_text(encoding="utf-8"))
    if latest.get("room") == args.room:
        print(json.dumps(latest, sort_keys=True))
    else:
        print(json.dumps({"found": False}))
`,
    "utf8",
  );

  await writeFile(
    path.join(dir, "record_cabinet_entry.py"),
    String.raw`import json
import sys
from pathlib import Path

argv = sys.argv[1:]
command = "append-rep" if "append-rep" in argv else "add"
record = {"command": command, "argv": argv, "files": {}}
for index, argument in enumerate(argv[:-1]):
    if argument.endswith("-file"):
        record["files"][argument] = Path(argv[index + 1]).read_text(encoding="utf-8")

calls_path = Path(__file__).resolve().parent / "cabinet_calls.jsonl"
with calls_path.open("a", encoding="utf-8") as handle:
    handle.write(json.dumps(record, sort_keys=True) + "\n")

record_id = 17 if command == "add" else 18
if command == "add":
    print(f"cabinet add: id={record_id}")
else:
    print(f"cabinet rep: id={record_id}")
`,
    "utf8",
  );

  return { dir, recordsPath: path.join(dir, "records.jsonl") };
}

async function readFakeMemoryRecords(recordsPath: string) {
  const records = await readFile(recordsPath, "utf8");
  return records.trim().split("\n").map((line) => JSON.parse(line));
}

async function readFakeCabinetCalls(dir: string) {
  const calls = await readFile(path.join(dir, "cabinet_calls.jsonl"), "utf8");
  return calls.trim().split("\n").map((line) => JSON.parse(line));
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
    expect(result.details).toMatchObject({ room: "example", ok: true });
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

  for (const { folder, spirit } of [
    { folder: "kintsu", spirit: "Kintsu" },
    { folder: "kodo", spirit: "Kodo" },
  ]) {
    test(`keeps legacy ${folder} room resolution`, async () => {
      const { cwd } = await makeTempRoom(folder);
      const { tools } = registerAdapter();

      const result = await executeTool(tools, "room_state", {}, { cwd });
      expect(result.isError).toBeUndefined();
      expect(result.details).toMatchObject({ room: folder, ok: true });
      expect(parseToolJson(result).state).toMatchObject({
        room: folder,
        agentName: spirit,
        embodiedSpirit: spirit,
      });
    });
  }
});

describe("OMP context hook runtime smoke", () => {
  test("injects hidden room and routing context without re-running existing substrate custom messages", async () => {
    const { cwd } = await makeTempKintsuCwd();
    await seedHouseState(cwd, {
      version: 1,
      room: "kintsu",
      operator: "Test Operator",
      embodiedSpirit: "Kintsu",
      agentName: "Kintsu",
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
    expect(additions[0].content).toContain("Room: kintsu");
    expect(additions[0].content).toContain("Active spirit: Kintsu");
    expect(additions[0].content).toContain("Operator: Test Operator");
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

  test("casual prompt without existing recall context skips auto recall while preserving room context", async () => {
    const { cwd } = await makeTempKintsuCwd();
    await seedHouseState(cwd, {
      version: 1,
      room: "kintsu",
      operator: "Test Operator",
      embodiedSpirit: "Kintsu",
      agentName: "Kintsu",
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
        .toContain("Room: kintsu");
      expect(additions.find((message) => message.customType === "solarisael-routing-mode")?.details)
        .toEqual({ enabled: true });
    });
  });
});

describe("OMP safe tool execute runtime smoke", () => {
  test("room state tools persist explicit room, spirit, and routing updates in the temp room", async () => {
    const { cwd } = await makeTempKintsuCwd();
    const { tools } = registerAdapter();
    const ctx = { cwd };

    const setState = await executeTool(tools, "set_room_state", { operator: "Smoke Tester", embodiedSpirit: "Kodo" }, ctx);
    expect(setState.isError).toBeUndefined();
    expect(parseToolJson(setState).state).toMatchObject({
      room: "kintsu",
      operator: "Smoke Tester",
      embodiedSpirit: "Kodo",
      agentName: "Kodo",
    });

    const activeSpirit = await readFile(path.join(cwd, "active_spirit.md"), "utf8");
    expect(activeSpirit).toContain("# Active Spirit: Kodo");
    expect(activeSpirit).toContain("Operator: Smoke Tester");

    const routingUpdate = await executeTool(tools, "house_routing_mode", { enabled: true }, ctx);
    expect(routingUpdate.isError).toBeUndefined();
    expect(routingUpdate.details?.routingMode).toMatchObject({ enabled: true });
    expect(parseToolJson(routingUpdate).routingMode).toMatchObject({ enabled: true });

    const roomState = await executeTool(tools, "room_state", {}, ctx);
    expect(roomState.isError).toBeUndefined();
    expect(parseToolJson(roomState).state).toMatchObject({
      room: "kintsu",
      operator: "Smoke Tester",
      embodiedSpirit: "Kodo",
      routingMode: { enabled: true },
    });
  });
  test("anamnesis read validates consult queries and anamnesis_write enforces operation fields", async () => {
    const { cwd } = await makeTempKintsuCwd();
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

  test("anamnesis_write round-trips drawer and repetition fields through the writer seam", async () => {
    const { cwd } = await makeTempKintsuCwd();
    const fakeSubstrate = await makeFakeSubstrate();
    const envSnapshot = snapshotEnv();
    const { tools } = registerAdapter();
    const ctx = { cwd };

    try {
      process.env.SOLARISAEL_SUBSTRATE = fakeSubstrate.dir;

      const add = await executeTool(
        tools,
        "anamnesis_write",
        {
          operation: "add",
          kind: "cycle",
          fidelity: "raw-material",
          activation: "fork",
          dormant: false,
          title: "Writer seam cycle",
          shape: "process",
          ramp: "Ramp body, byte-for-byte.",
          counsel: "Counsel body.",
          peak: "Peak body.",
          beginning: "Beginning body.",
          verifyNote: "Verify this before acting.",
          canon: ["canon/a", "canon/b"],
          sourcePaths: ["memory/a.md", "memory/b.md"],
          tags: ["writer", "seam"],
          seedRep: {
            number: 1,
            occurredOn: "2026-07-16",
            howItWent: "The first repetition landed.",
            portalPull: "The old portal pulled.",
            lighter: "The next pass is lighter.",
          },
        },
        ctx,
      );
      expect(add.isError).toBe(false);
      expect(parseToolJson(add)).toMatchObject({ ok: true, id: 17 });

      const append = await executeTool(
        tools,
        "anamnesis_write",
        {
          operation: "append-rep",
          title: "Writer seam cycle",
          repNumber: 2,
          occurredOn: "2026-07-17",
          howItWent: "The second repetition landed.",
          portalPull: "The portal still pulled.",
          lighter: "The path shortened.",
          sourcePaths: ["memory/c.md"],
        },
        ctx,
      );
      expect(append.isError).toBe(false);
      expect(parseToolJson(append)).toMatchObject({ ok: true, id: 18 });

      const calls = await readFakeCabinetCalls(fakeSubstrate.dir);
      expect(calls).toHaveLength(2);
      expect(calls[0].command).toBe("add");
      expect(calls[0].argv).not.toContain("--dormant");
      expect(calls[0].argv).toContain("--seed-rep-number");
      expect(calls[0].files).toMatchObject({
        "--ramp-file": "Ramp body, byte-for-byte.",
        "--counsel-file": "Counsel body.",
        "--peak-file": "Peak body.",
        "--beginning-file": "Beginning body.",
        "--verify-note-file": "Verify this before acting.",
        "--seed-rep-how-file": "The first repetition landed.",
        "--seed-rep-portal-file": "The old portal pulled.",
        "--seed-rep-lighter-file": "The next pass is lighter.",
      });
      expect(calls[1].command).toBe("append-rep");
      expect(calls[1].argv).toContain("--rep-number");
      expect(calls[1].files).toMatchObject({
        "--how-it-went-file": "The second repetition landed.",
        "--portal-pull-file": "The portal still pulled.",
        "--lighter-file": "The path shortened.",
      });
    } finally {
      restoreEnv(envSnapshot);
      await rm(fakeSubstrate.dir, { recursive: true, force: true });
    }
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

  test("remember, sleep, and wake round-trip through the substrate script seam", async () => {
    const { cwd } = await makeTempKintsuCwd();
    const fakeSubstrate = await makeFakeSubstrate();
    const envSnapshot = snapshotEnv();
    const { tools } = registerAdapter();
    const ctx = { cwd };

    try {
      process.env.SOLARISAEL_SUBSTRATE = fakeSubstrate.dir;

      const remember = await executeTool(
        tools,
        "remember",
        {
          title: "Substrate seam memory",
          body: "Remember body delivered on stdin.",
          supersedes: ["41", "42", "41"],
        },
        ctx,
      );
      expect(remember.isError).toBe(false);
      const rememberJson = parseToolJson(remember);
      expect(rememberJson).toMatchObject({ ok: true, id: 1 });

      const rememberRecords = await readFakeMemoryRecords(fakeSubstrate.recordsPath);
      expect(rememberRecords).toHaveLength(1);
      expect(rememberRecords[0]).toMatchObject({
        id: 1,
        room: "kintsu",
        type: "session",
        title: "Substrate seam memory",
        body: "Remember body delivered on stdin.",
        threads: [],
        supersedes: ["41", "42"],
        backup: false,
        no_backup: true,
      });
      expect(String(rememberRecords[0].source_path).startsWith("memory/omp_")).toBe(true);
      expect(rememberJson.sourcePath).toBe(rememberRecords[0].source_path);

      const sleep = await executeTool(
        tools,
        "sleep",
        { body: "Paper boat body delivered on stdin." },
        ctx,
      );
      expect(sleep.isError).toBe(false);
      const sleepJson = parseToolJson(sleep);
      expect(sleepJson).toMatchObject({ ok: true, id: 2 });

      const sleepRecords = await readFakeMemoryRecords(fakeSubstrate.recordsPath);
      expect(sleepRecords).toHaveLength(2);
      expect(sleepRecords[1]).toMatchObject({
        id: 2,
        room: "kintsu",
        type: "paper-boat",
        body: "Paper boat body delivered on stdin.",
        threads: ["paper boat / sleep / for tomorrow"],
        backup: true,
        no_backup: false,
      });
      expect(String(sleepRecords[1].title).startsWith("paper boat — ")).toBe(true);
      expect(String(sleepRecords[1].source_path).startsWith("db-only/paper-boats/")).toBe(true);
      expect(sleepJson.sourcePath).toBe(sleepRecords[1].source_path);

      const wake = await executeTool(tools, "wake", {}, ctx);
      expect(wake.isError).toBe(false);
      expect(parseToolJson(wake)).toMatchObject({
        ok: true,
        found: true,
        title: sleepRecords[1].title,
        body: "Paper boat body delivered on stdin.",
        source_path: sleepRecords[1].source_path,
      });
    } finally {
      restoreEnv(envSnapshot);
      await rm(fakeSubstrate.dir, { recursive: true, force: true });
    }
  });

  test("remember rejects invalid supersession IDs and lesson-store supersession", async () => {
    const { cwd } = await makeTempKintsuCwd();
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
    expect(readyDispatch.isError).toBe(false);
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
      status: "rejected",
      lane: null,
      taskPacket: null,
    });
    expect(rejectedJson.errors).toEqual(["Unknown worker lane: advisor"]);
  });

  test("model default tool resolves before saving, applies resolved selectors, clears them, and reports validation errors", async () => {
    const { cwd } = await makeTempKintsuCwd();
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
    expect(missingSelector.content?.[0]?.text).toBe("Could not resolve model selector for this session: missing-model");
    expect(appliedModels).toEqual([]);

    const enableWithoutModel = await executeTool(tools, "house_model_default", { enabled: true }, ctx);
    expect(enableWithoutModel.isError).toBe(true);
    expect(enableWithoutModel.content?.[0]?.text).toBe("Cannot enable room model default without a model selector.");
    expect(appliedModels).toEqual([]);

    const applied = await executeTool(
      tools,
      "house_model_default",
      { model: "pi/default", enabled: true, applyNow: true },
      ctx,
    );
    expect(applied.isError).toBeUndefined();
    expect(applied.details).toMatchObject({ ok: true, applied: true });
    expect(parseToolJson(applied)).toMatchObject({
      modelDefault: { enabled: true, model: "pi/default" },
      applied: true,
    });
    expect(appliedModels).toEqual(["pi/default"]);
    expect(resolved).toContain("missing-model");
    expect(resolved).toContain("pi/default");

    const cleared = await executeTool(tools, "house_model_default", { clear: true }, ctx);
    expect(cleared.isError).toBeUndefined();
    expect(cleared.details).toMatchObject({ ok: true, applied: false });
    expect(parseToolJson(cleared)).toMatchObject({
      modelDefault: { enabled: false, model: null },
      applied: false,
    });
    expect(appliedModels).toEqual(["pi/default"]);
  });
});
