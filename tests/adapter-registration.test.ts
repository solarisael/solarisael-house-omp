import { describe, expect, test, afterEach } from "bun:test";

import solarisaelHouseProof from "../index.ts";
import { RustJsonlTransport } from "../rust-transport.ts";
import { closeRustRecallTransports, recallWithRouting } from "../solarisael-house-proof/recall.ts";
type CapturedTool = {
  name: string;
  parameters: Schema;
  approval?: string;
  execute?: (...args: unknown[]) => Promise<{ details?: unknown }>;
};

type Schema = {
  kind: "string" | "boolean" | "number" | "enum" | "object" | "array";
  isOptional?: boolean;
  values?: string[];
  shape?: Record<string, Schema>;
  element?: Schema;
  describe(description: string): Schema;
  optional(): Schema;
  default(value: unknown): Schema;
};

type SchemaSummary =
  | { type: "string"; optional?: true }
  | { type: "boolean"; optional?: true }
  | { type: "number"; optional?: true }
  | { type: "enum"; values: string[]; optional?: true }
  | { type: "array"; element: SchemaSummary; optional?: true }
  | { type: "object"; fields: Record<string, SchemaSummary>; optional?: true };

function makeSchema(kind: Schema["kind"], fields: Partial<Schema> = {}): Schema {
  return {
    kind,
    ...fields,
    describe(_description: string) {
      return this;
    },
    optional() {
      this.isOptional = true;
      return this;
    },
    default(_value: unknown) {
      return this;
    },
  } as Schema;
}

const zodStub = {
  string() {
    return makeSchema("string");
  },
  boolean() {
    return makeSchema("boolean");
  },
  enum(values: string[]) {
    return makeSchema("enum", { values });
  },
  object(shape: Record<string, Schema>) {
    return makeSchema("object", { shape });
  },
  number() {
    return makeSchema("number");
  },
  array(element: Schema) {
    return makeSchema("array", { element });
  },
};

function summarizeSchema(schema: Schema): SchemaSummary {
  const optional = schema.isOptional ? { optional: true as const } : {};

  switch (schema.kind) {
    case "string":
      return { type: "string", ...optional };
    case "boolean":
      return { type: "boolean", ...optional };
    case "number":
      return { type: "number", ...optional };
    case "enum":
      return { type: "enum", values: schema.values ?? [], ...optional };
    case "array":
      if (!schema.element) throw new Error("array schema missing element");
      return { type: "array", element: summarizeSchema(schema.element), ...optional };
    case "object":
      return {
        type: "object",
        fields: Object.fromEntries(
          Object.entries(schema.shape ?? {}).map(([key, value]) => [key, summarizeSchema(value)]),
        ),
        ...optional,
      };
  }
}

function registerAdapter() {
  const labels: string[] = [];
  const hooks: Array<{ name: string; handler: unknown }> = [];
  const tools: CapturedTool[] = [];

  const pi = {
    zod: zodStub,
    setLabel(label: string) {
      labels.push(label);
    },
    on(name: string, handler: unknown) {
      hooks.push({ name, handler });
    },
    registerTool(tool: CapturedTool) {
      tools.push(tool);
    },
  };
  solarisaelHouseProof(pi);
  return { labels, hooks, tools };
}

const expectedToolNames = [
  "recall",
  "remember",
  "delete_lesson",
  "update_lesson",
  "wake",
  "anamnesis",
  "anamnesis_write",
  "room_state",
  "set_room_state",
  "coding_lessons",
  "sleep",
  "house_lane_status",
  "house_dispatch",
  "house_routing_mode",
  "house_model_default",
];

function toolMap(tools: CapturedTool[]) {
  return Object.fromEntries(tools.map((tool) => [tool.name, tool]));
}

describe("OMP adapter registration", () => {
  test("registers the public adapter label and lifecycle hooks", () => {
    const { labels, hooks } = registerAdapter();

    expect(labels).toEqual(["Solarisael House"]);
    expect(hooks.map((hook) => hook.name)).toEqual(["context", "shutdown", "agent_end"]);
    expect(hooks.every((hook) => typeof hook.handler === "function")).toBe(true);
  });

  test("registers the Solarisael tool surface", () => {
    const { tools } = registerAdapter();

    expect(tools).toHaveLength(expectedToolNames.length);

    expect(new Set(tools.map((tool) => tool.name))).toEqual(new Set(expectedToolNames));
    expect(toolMap(tools)).toMatchObject({
      recall: { approval: "read" },
      remember: { approval: "write" },
      delete_lesson: { approval: "write" },
      update_lesson: { approval: "write" },
      wake: { approval: "read" },
      anamnesis: { approval: "read" },
      anamnesis_write: { approval: "write" },
      room_state: { approval: "read" },
      set_room_state: { approval: "write" },
      coding_lessons: { approval: "read" },
      sleep: { approval: "write" },
      house_lane_status: { approval: "read" },
      house_dispatch: { approval: "read" },
      house_routing_mode: { approval: "write" },
      house_model_default: { approval: "write" },
    });
  });
 
  test("closes cached Rust workers through the adapter shutdown hook", async () => {
    const originalRust = process.env.SOLARISAEL_HOUSE_RUST;
    const originalRequest = RustJsonlTransport.prototype.request;
    const originalClose = RustJsonlTransport.prototype.close;
    let closed = 0;
    process.env.SOLARISAEL_HOUSE_RUST = "shutdown-test";
    RustJsonlTransport.prototype.request = async function () {
      return {
        ok: true,
        query: "alpha",
        found: false,
        source: "rust-postgres",
        retrievalCandidates: [],
        canonMatches: [],
        semanticChunks: [],
        contentChunks: [],
        dateMatches: [],
        queryDates: [],
        taxonomy: { memoryTypes: [], threadKeys: ["process"], namedEntities: [] },
      };
    };
    RustJsonlTransport.prototype.close = function () {
      closed += 1;
      return originalClose.call(this);
    };
    try {
      await recallWithRouting("room-dir", "example", "alpha");
      const { hooks } = registerAdapter();
      const shutdown = hooks.find((hook) => hook.name === "shutdown");
      expect(shutdown).toBeDefined();
      shutdown.handler();
      expect(closed).toBe(1);
    } finally {
      closeRustRecallTransports();
      RustJsonlTransport.prototype.request = originalRequest;
      RustJsonlTransport.prototype.close = originalClose;
      if (originalRust === undefined) delete process.env.SOLARISAEL_HOUSE_RUST;
      else process.env.SOLARISAEL_HOUSE_RUST = originalRust;
    }
  });

  test("exposes the OMP parameter schemas for each registered tool", () => {
    const { tools } = registerAdapter();
    const schemas = Object.fromEntries(
      Object.entries(toolMap(tools)).map(([name, tool]) => [name, summarizeSchema(tool.parameters)]),
    );

    expect(schemas).toEqual({
      recall: {
        type: "object",
        fields: {
          query: { type: "string" },
        },
      },
      remember: {
        type: "object",
        fields: {
          title: { type: "string" },
          body: { type: "string" },
          kind: {
            type: "enum",
            values: ["memory", "coding-lesson", "project-lesson", "writing-lesson", "audio-lesson"],
            optional: true,
          },
          threads: { type: "array", element: { type: "string" }, optional: true },
          supersedes: { type: "array", element: { type: "string" }, optional: true },
          shape: { type: "string", optional: true },
          voice: { type: "string", optional: true },
          scope: { type: "string", optional: true },
          project: { type: "string", optional: true },
          proofPattern: { type: "string", optional: true },
          triggerContext: { type: "string", optional: true },
          tags: { type: "array", element: { type: "string" }, optional: true },
        },
      },
      delete_lesson: {
        type: "object",
        fields: {
          kind: { type: "enum", values: ["coding-lesson", "project-lesson"] },
          id: { type: "string" },
          expectedTitle: { type: "string" },
        },
      },
      update_lesson: {
        type: "object",
        fields: {
          kind: { type: "enum", values: ["coding-lesson", "project-lesson"] },
          id: { type: "string" },
          expectedTitle: { type: "string" },
          title: { type: "string", optional: true },
          body: { type: "string", optional: true },
          shape: { type: "string", optional: true },
          triggerContext: { type: "string", optional: true },
          tags: { type: "array", element: { type: "string" }, optional: true },
          voice: { type: "string", optional: true },
          scope: { type: "string", optional: true },
          project: { type: "string", optional: true },
          proofPattern: { type: "string", optional: true },
          negationOf: { type: "string", optional: true },
          clearNegationOf: { type: "boolean", optional: true },
        },
      },
      wake: { type: "object", fields: {} },
      anamnesis: {
        type: "object",
        fields: {
          mode: { type: "enum", values: ["wake", "consult"] },
          query: { type: "string", optional: true },
          limit: { type: "number", optional: true },
        },
      },
      anamnesis_write: {
        type: "object",
        fields: {
          operation: { type: "enum", values: ["add", "append-rep"] },
          kind: { type: "enum", values: ["pillar", "cycle"], optional: true },
          fidelity: { type: "enum", values: ["record", "raw-material"], optional: true },
          activation: { type: "enum", values: ["wake", "fork"], optional: true },
          dormant: { type: "boolean", optional: true },
          title: { type: "string" },
          shape: { type: "string", optional: true },
          ramp: { type: "string", optional: true },
          counsel: { type: "string", optional: true },
          peak: { type: "string", optional: true },
          beginning: { type: "string", optional: true },
          verifyNote: { type: "string", optional: true },
          canon: { type: "array", element: { type: "string" }, optional: true },
          sourcePaths: { type: "array", element: { type: "string" }, optional: true },
          tags: { type: "array", element: { type: "string" }, optional: true },
          allowEmptyCycle: { type: "boolean", optional: true },
          seedRep: { type: "object", optional: true, fields: { number: { type: "number" }, occurredOn: { type: "string", optional: true }, howItWent: { type: "string" }, portalPull: { type: "string" }, lighter: { type: "string" } } },
          repNumber: { type: "number", optional: true },
          occurredOn: { type: "string", optional: true },
          howItWent: { type: "string", optional: true },
          portalPull: { type: "string", optional: true },
          lighter: { type: "string", optional: true },
        },
      },
      room_state: { type: "object", fields: {} },
      set_room_state: {
        type: "object",
        fields: {
          operator: { type: "string", optional: true },
          embodiedSpirit: { type: "string", optional: true },
        },
      },
      coding_lessons: {
        type: "object",
        fields: {
          shape: { type: "string" },
        },
      },
      sleep: {
        type: "object",
        fields: {
          body: { type: "string" },
        },
      },
      house_lane_status: { type: "object", fields: {} },
      house_dispatch: {
        type: "object",
        fields: {
          lane: { type: "string" },
          task: { type: "string" },
          target: { type: "string", optional: true },
          context: {
            type: "array",
            optional: true,
            element: {
              type: "object",
              fields: {
                mode: { type: "enum", values: ["exact", "gist", "image-ok", "retrieve-only"] },
                source: { type: "string", optional: true },
                content: { type: "string", optional: true },
                reason: { type: "string", optional: true },
              },
            },
          },
          acceptance: { type: "array", element: { type: "string" }, optional: true },
          risk: { type: "enum", values: ["low", "medium", "high"], optional: true },
          model: { type: "string", optional: true },
        },
      },
      house_routing_mode: {
        type: "object",
        fields: {
          enabled: { type: "boolean", optional: true },
        },
      },
      house_model_default: {
        type: "object",
        fields: {
          model: { type: "string", optional: true },
          enabled: { type: "boolean", optional: true },
          applyNow: { type: "boolean", optional: true },
          clear: { type: "boolean", optional: true },
        },
      },
    });
  });

  test("lesson writes reach store validation instead of an undefined registry", async () => {
    const remember = toolMap(registerAdapter().tools).remember;
    expect(remember.execute).toBeFunction();

    const result = await remember.execute!(
      "remember-regression",
      { title: "Regression", body: "Regression", kind: "project-lesson" },
      undefined,
      undefined,
      { cwd: process.cwd() },
    );

    expect(result.details).toEqual({
      ok: false,
      error: "kind 'project-lesson' requires field 'project'",
    });
  });
});
