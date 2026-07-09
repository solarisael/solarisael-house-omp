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
import { catchBoat, runCodingLessons, writeLessonStore, writeSessionMemory } from "./substrate.ts";
import { REMEMBER_STORES, buildStoreArgs } from "./stores.ts";
import { dispatchWorker, laneStatus } from "./routing.ts";

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
    description: "Write a memory or lesson to the Solarisael substrate. Use when something worth keeping happened.",
    parameters: z.object({
      title: z.string().describe("Short title."),
      body: z.string().describe("Markdown body: what actually happened, or the lesson text."),
      kind: z.enum(["memory", "coding-lesson", "project-lesson", "writing-lesson", "audio-lesson"]).optional()
        .describe("Destination store. memory (default): a thing that happened. coding-lesson: a reusable code rule with a proof pattern. project-lesson: a project-wide rule (requires 'project'). writing-lesson: a prose-taste rule (register, voice, wit mechanics). audio-lesson: an audio-pipeline rule."),
      threads: z.array(z.string()).optional().describe("memory only: thread keys, 'concept / variant / variant'."),
      shape: z.string().optional().describe("lesson kinds: shape taxonomy value (e.g. process, naming, refusal)."),
      voice: z.string().optional().describe("coding/writing lessons: voice (e.g. kodo, sol-craft)."),
      scope: z.string().optional().describe("coding-lesson: scope (shared or a room name)."),
      project: z.string().optional().describe("project-lesson (required) or coding-lesson: project name."),
      proofPattern: z.string().optional().describe("coding/project lessons: the proof pattern."),
      triggerContext: z.string().optional().describe("lesson kinds: when this lesson should fire."),
      tags: z.array(z.string()).optional().describe("lesson kinds: tags."),
    }),
    approval: "write",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { room, sharedRoot } = roomContext(ctx.cwd);
      const kind = params.kind || "memory";
      const refuse = (error) => {
        const result = { ok: false, error };
        return { isError: true, content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
      };

      if (kind === "memory") {
        const lessonOnly = ["shape", "voice", "scope", "project", "proofPattern", "triggerContext", "tags"].filter((key) => {
          const value = params[key];
          return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== "";
        });
        if (lessonOnly.length > 0) return refuse(`kind 'memory' does not accept: ${lessonOnly.join(", ")} — pick a lesson kind or drop the field(s)`);
        const result = await writeSessionMemory({ sharedRoot, room, title: params.title, body: params.body, backup: false, threads: params.threads || [] });
        return { isError: !result.ok, content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
      }

      if (Array.isArray(params.threads) && params.threads.length > 0) return refuse("threads are memory-only; lesson stores do not take threads");
      const store = REMEMBER_STORES[kind];
      const built = buildStoreArgs(kind, store, {
        shape: params.shape,
        voice: params.voice,
        scope: params.scope,
        project: params.project,
        proofPattern: params.proofPattern,
        triggerContext: params.triggerContext,
        tags: params.tags,
      });
      if (!built.ok) return refuse(built.error);
      const result = await writeLessonStore({ sharedRoot, store, title: params.title, body: params.body, extraArgs: built.args });
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

  pi.registerTool({
    name: "house_lane_status",
    label: "Solarisael House Lane Status",
    description: [
      "List deterministic Solarisael House worker lanes and their routing policies.",
      "Advisor review is reported separately and is not a dispatchable worker lane.",
    ].join("\n"),
    parameters: z.object({}),
    approval: "read",
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const result = await laneStatus();
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
    },
  });

  pi.registerTool({
    name: "house_dispatch",
    label: "Solarisael House Dispatch",
    description: [
      "Validate a named Solarisael House worker lane and build a bounded OMP task packet.",
      "This v0 tool does not spawn subagents itself; the main model uses the receipt to call task/agent explicitly.",
      "Use named lanes. Optionally override the spawn model per dispatch; enforcement requires spawning via the eval agent() helper with the packet's model.",
    ].join("\n"),
    parameters: z.object({
      lane: z.string().describe("Named worker lane, for example smol-scout, smol-executor, tester, or verifier."),
      task: z.string().describe("Exact work packet the worker should execute."),
      target: z.string().optional().describe("Exact target files/symbols/non-goals when known."),
      context: z.array(z.object({
        mode: z.enum(["exact", "gist", "image-ok", "retrieve-only"]).describe("Context treatment policy for this fragment."),
        source: z.string().optional().describe("Source path, URI, or handle for this context fragment."),
        content: z.string().optional().describe("Small inline context fragment, when safe."),
        reason: z.string().optional().describe("Why this fragment is included."),
      })).optional().describe("Context fragments tagged by exact/gist/image/retrieve-only policy."),
      acceptance: z.array(z.string()).optional().describe("Observable acceptance checks the worker must satisfy."),
      risk: z.enum(["low", "medium", "high"]).optional().describe("Dispatch risk label for receipt/context."),
      model: z.string().optional().describe("Optional per-dispatch model override: an OMP alias (smol | default | slow) or an exact provider model id. Defaults to the lane's model role mapping."),
    }),
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const result = await dispatchWorker(params);
      return {
        isError: !result.ok,
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "house_routing_mode",
    label: "Solarisael House Routing Mode",
    description: "Read or toggle the default worker-routing modus operandi for this room.",
    parameters: z.object({
      enabled: z.boolean().optional().describe("When true, inject worker-routing guidance on future turns in this room."),
    }),
    approval: "write",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { room, spirit, effectiveRoomDir } = roomContext(ctx.cwd);
      const current = await loadRoomState(effectiveRoomDir, room, spirit);
      const hasUpdate = typeof params.enabled === "boolean";
      const next = hasUpdate
        ? await saveRoomState(effectiveRoomDir, {
          ...current,
          routingMode: {
            ...(current.routingMode || {}),
            enabled: params.enabled,
            updatedAt: new Date().toISOString(),
          },
        })
        : current;
      return {
        content: [{ type: "text", text: JSON.stringify({ path: statePathForRoom(effectiveRoomDir), routingMode: next.routingMode }, null, 2) }],
        details: { room, ok: true, routingMode: next.routingMode },
      };
    },
  });

  pi.registerTool({
    name: "house_model_default",
    label: "Solarisael House Model Default",
    description: "Read or set this room's default OMP model selector. Applied once near session start when enabled.",
    parameters: z.object({
      model: z.string().optional().describe("Provider/model id or role alias such as pi/default, pi/slow, or an exact provider model."),
      enabled: z.boolean().optional().describe("Enable or disable applying the stored model default on future turns."),
      applyNow: z.boolean().optional().default(true).describe("Apply the resolved model immediately after saving, when possible."),
      clear: z.boolean().optional().describe("Clear the stored room model default."),
    }),
    approval: "write",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { room, spirit, effectiveRoomDir } = roomContext(ctx.cwd);
      const current = await loadRoomState(effectiveRoomDir, room, spirit);
      const modelDefault = { ...(current.modelDefault || {}) };
      const model = typeof params.model === "string" ? params.model.trim() : "";

      if (model) {
        const resolved = ctx.models?.resolve?.(model);
        if (!resolved) {
          return {
            isError: true,
            content: [{ type: "text", text: `Could not resolve model selector for this session: ${model}` }],
            details: { room, ok: false, model },
          };
        }
        modelDefault.model = model;
      }

      if (params.clear) {
        modelDefault.enabled = false;
        modelDefault.model = null;
      }
      if (typeof params.enabled === "boolean") modelDefault.enabled = params.enabled;
      if (modelDefault.enabled && !modelDefault.model) {
        return {
          isError: true,
          content: [{ type: "text", text: "Cannot enable room model default without a model selector." }],
          details: { room, ok: false },
        };
      }

      const shouldSave = Boolean(model || params.clear || typeof params.enabled === "boolean");
      const next = shouldSave
        ? await saveRoomState(effectiveRoomDir, {
          ...current,
          modelDefault: {
            ...modelDefault,
            updatedAt: new Date().toISOString(),
          },
        })
        : current;

      let applied = false;
      if (params.applyNow !== false && next.modelDefault?.enabled && next.modelDefault?.model && typeof pi.setModel === "function") {
        const resolved = ctx.models?.resolve?.(next.modelDefault.model);
        if (resolved) {
          await pi.setModel(next.modelDefault.model);
          applied = true;
        }
      }

      return {
        content: [{ type: "text", text: JSON.stringify({ path: statePathForRoom(effectiveRoomDir), modelDefault: next.modelDefault, applied }, null, 2) }],
        details: { room, ok: true, modelDefault: next.modelDefault, applied },
      };
    },
  });
}
