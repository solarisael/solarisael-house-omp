import { describe, expect, test } from "bun:test";

import solarisaelHouseProof from "../index.ts";

type CapturedTool = {
  name: string;
  parameters: Schema;
  approval?: string;
};

type Schema = {
  kind: "string" | "boolean" | "enum" | "object" | "array";
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
  "wake",
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
    expect(hooks.map((hook) => hook.name)).toEqual(["context", "agent_end"]);
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
      wake: { approval: "read" },
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
      wake: { type: "object", fields: {} },
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
});
