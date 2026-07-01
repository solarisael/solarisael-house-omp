// Tool registration for the OMP adapter.
// Silhouette: expose room/substrate tools; keep hook wiring out of tool bodies.

import { compactRecall, recallWithFallback } from "./recall.ts";
import {
  loadRoomState,
  roomContext,
  saveRoomState,
  statePathForRoom,
  writeActiveSpiritSnapshot,
} from "./room.ts";
import { catchBoat, runCodingLessons, writeSessionMemory } from "./substrate.ts";

export function registerSolarisaelTools(pi) {
  const z = pi.zod;

  pi.registerTool({
    name: "recall",
    label: "Solarisael Recall",
    description: [
      "Query the Solarisael House substrate for canon, memory chunks, semantic/content matches, and a compact taxonomy map.",
      "Use this when you notice your own uncertainty about load-bearing names, concepts, or facts.",
      "Use the taxonomy map as a bounded menu for better follow-up recall queries; do not guess shape names blindly.",
      "If no canonical match is returned, do not invent from adjacent matches; state the gap honestly.",
    ].join("\n"),
    parameters: z.object({
      query: z.string().describe("Specific natural-language memory/canon query."),
    }),
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { room, effectiveRoomDir } = roomContext(ctx.cwd);

      try {
        const recalled = await recallWithFallback(effectiveRoomDir, room, params.query);
        if (!recalled.ok) {
          return {
            isError: true,
            content: [{ type: "text", text: JSON.stringify(recalled.result, null, 2) }],
            details: { room, ok: false },
          };
        }
        const compact = compactRecall(recalled.result, { includeTaxonomy: true });
        return {
          content: [{ type: "text", text: JSON.stringify(compact, null, 2) }],
          details: { room, ok: Boolean(compact.ok), found: Boolean(compact.found) },
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Solarisael recall failed: ${err?.message || String(err)}` }],
          details: { room, error: err?.message || String(err) },
        };
      }
    },
  });

  pi.registerTool({
    name: "remember",
    label: "Solarisael Remember",
    description: "Write a memory to the Solarisael substrate. Use when something worth keeping happened.",
    parameters: z.object({
      title: z.string().describe("Short memory title."),
      body: z.string().describe("Markdown body. Plainly record what actually happened."),
    }),
    approval: "write",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { room, sharedRoot } = roomContext(ctx.cwd);
      const result = await writeSessionMemory({ sharedRoot, room, title: params.title, body: params.body, backup: false });
      return { isError: !result.ok, content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
    },
  });

  pi.registerTool({
    name: "wake",
    label: "Solarisael Wake",
    description: "Catch the latest paper boat for this room.",
    parameters: z.object({}),
    approval: "read",
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const { room, sharedRoot } = roomContext(ctx.cwd);
      const result = await catchBoat(sharedRoot, room);
      return { isError: !result.ok, content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
    },
  });

  pi.registerTool({
    name: "room_state",
    label: "Solarisael Room State",
    description: "Read the current Solarisael room agency state for this workspace.",
    parameters: z.object({}),
    approval: "read",
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const { room, spirit, effectiveRoomDir } = roomContext(ctx.cwd);
      const state = await loadRoomState(effectiveRoomDir, room, spirit);
      return { content: [{ type: "text", text: JSON.stringify({ path: statePathForRoom(effectiveRoomDir), state }, null, 2) }], details: { room, ok: true } };
    },
  });

  pi.registerTool({
    name: "set_room_state",
    label: "Solarisael Set Room State",
    description: "Update safe room agency fields: operator and embodiedSpirit (Kodo/Kintsu only). Also refreshes active_spirit.md.",
    parameters: z.object({
      operator: z.string().optional().describe("Operator display name, usually Sol."),
      embodiedSpirit: z.enum(["Kintsu", "Kodo"]).optional().describe("Active supported room spirit."),
    }),
    approval: "write",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { room, spirit, effectiveRoomDir } = roomContext(ctx.cwd);
      const current = await loadRoomState(effectiveRoomDir, room, spirit);
      const next = await saveRoomState(effectiveRoomDir, {
        ...current,
        ...(params.operator ? { operator: params.operator } : {}),
        ...(params.embodiedSpirit ? { embodiedSpirit: params.embodiedSpirit, agentName: params.embodiedSpirit, lastSpiritChangeAt: new Date().toISOString() } : {}),
      });
      await writeActiveSpiritSnapshot(effectiveRoomDir, next);
      return { content: [{ type: "text", text: JSON.stringify({ path: statePathForRoom(effectiveRoomDir), state: next }, null, 2) }], details: { room, ok: true } };
    },
  });

  pi.registerTool({
    name: "coding_lessons",
    label: "Solarisael Coding Lessons",
    description: "Fetch coding/process lesson pairs from the substrate for a shape such as process. Use before risky process or tooling choices.",
    parameters: z.object({
      shape: z.string().default("process").describe("Lesson shape to fetch, usually process."),
    }),
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { room, effectiveRoomDir } = roomContext(ctx.cwd);
      const result = await runCodingLessons(effectiveRoomDir, room, params.shape || "process");
      const text = result.ok
        ? JSON.stringify({ shape: params.shape || "process", lessons: result.lessons, taxonomy: result.taxonomy || null }, null, 2)
        : JSON.stringify(result, null, 2);
      return { isError: !result.ok, content: [{ type: "text", text }], details: { room, ok: result.ok } };
    },
  });

  pi.registerTool({
    name: "sleep",
    label: "Solarisael Sleep",
    description: "Close the session by writing one paper boat with backup enabled.",
    parameters: z.object({
      body: z.string().describe("Markdown boat: what happened, for tomorrow, reminders."),
    }),
    approval: "write",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { room, sharedRoot } = roomContext(ctx.cwd);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const title = `paper boat — ${new Date().toISOString().slice(0, 10)}`;
      const result = await writeSessionMemory({
        sharedRoot,
        room,
        title,
        body: params.body,
        backup: true,
        type: "paper-boat",
        sourcePath: `db-only/paper-boats/${stamp}.md`,
        threads: ["paper boat / sleep / for tomorrow"],
      });
      return { isError: !result.ok, content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
    },
  });
}
