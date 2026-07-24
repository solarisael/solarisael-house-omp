// Tool registration for the OMP adapter.
// Silhouette: expose room/substrate tools; keep hook wiring out of tool bodies.
import { createHash } from "node:crypto";
 

import { compactRecall, recallWithRouting } from "./recall.ts";
import {
  loadRoomState,
  normalizeSpiritName,
  roomContext,
  saveRoomState,
  statePathForRoom,
  writeActiveSpiritSnapshot,
} from "./room.ts";
import { queryAnamnesis, formatAnamnesisContext } from "./anamnesis.ts";
import {
  appendAnamnesisRep,
  catchBoat,
  deleteLesson,
  runCodingLessons,
  substrateHealth,
  memorySourcePath,
  updateLesson,
  writeAnamnesisDrawer,
  writeLessonStore,
  writeSessionMemory,
} from "./substrate.ts";
import { RustJsonlTransport, RustTransportError, RustTransportOutcomeUnknownError } from "../rust-transport.ts";
import { discoverRustExecutable } from "../discovery.ts";
import { dispatchWorker, laneStatus } from "./routing.ts";
import { REMEMBER_STORES, buildStoreArgs } from "./stores.ts";
import { WRITE_TIMEOUT_MS } from "./constants.ts";

const rustRememberTransports = new Map<string, RustJsonlTransport>();

function rustRememberTransport(): RustJsonlTransport | null {
  const executable = discoverRustExecutable();
  if (!executable) return null;
  let transport = rustRememberTransports.get(executable);
  if (transport && !transport.usable) {
    rustRememberTransports.delete(executable);
    transport.close();
    transport = undefined;
  }
  if (!transport) {
    transport = new RustJsonlTransport({ executable });
    rustRememberTransports.set(executable, transport);
  }
  return transport;
}

function evictRustRememberTransport(executable: string, transport: RustJsonlTransport): void {
  if (rustRememberTransports.get(executable) !== transport) return;
  rustRememberTransports.delete(executable);
  transport.close();
}

function sourcePathKey(value: unknown): string {
  return String(value ?? "").replace(/\\/g, "/").replace(/^house\//i, "").toLowerCase();
}

function deterministicMemorySourcePath(room: string, title: string, body: string, threads: unknown[], supersedes: unknown[]): string {
  const canonical = JSON.stringify({ room, title, body, threads, supersedes });
  const digest = createHash("sha256").update(canonical).digest("hex").slice(0, 24);
  const baseline = memorySourcePath(title, new Date(0));
  return baseline.replace(/^memory\/omp_[^_]+_/, `memory/omp_${digest}_`);
}
function isOutcomeUnknownError(error: unknown): boolean {
  return error instanceof RustTransportOutcomeUnknownError;
}

async function reconcileRustMemory(room: string, sourcePath: string, signal?: AbortSignal) {
  try {
    const recalled = await recallWithRouting("", room, sourcePath, { signal });
    if (!recalled.ok) return { reconciled: false, committed: null };
    const result = recalled.result as Record<string, unknown>;
    const collections = ["retrievalCandidates", "semanticChunks", "contentChunks", "dateMatches"];
    const committed = collections.some((name) => (
      Array.isArray(result[name])
      && result[name].some((entry) => sourcePathKey((entry as Record<string, unknown>)?.source_path) === sourcePathKey(sourcePath))
    ));
    return { reconciled: true, committed };
  } catch {
    return { reconciled: false, committed: null };
  }
}

function unknownWriteReceipt(error: unknown, sourcePath: string, reconciliation: { reconciled: boolean; committed: boolean | null }) {
  return {
    ok: false,
    error: "Rust remember write outcome is unknown after dispatch",
    code: "outcome_unknown",
    outcome: "unknown",
    retryable: true,
    sourcePath,
    reconciled: reconciliation.reconciled,
    details: (error as { details?: unknown })?.details,
  };
}

function unknownLessonReceipt(): Record<string, unknown> {
  return {
    ok: false,
    error: "Rust lesson write outcome is unknown after dispatch",
    code: "outcome_unknown",
    outcome: "unknown",
    retryable: true,
  };
}

async function writeRustMemory({ room, title, body, threads, supersedes, signal }) {
  const executable = discoverRustExecutable();
  const transport = rustRememberTransport();
  if (!transport) return null;
  const normalizeIdentityValues = (values: unknown) => [...new Set((Array.isArray(values) ? values : []).map(String).map((value) => value.trim()).filter(Boolean))].sort();
  const normalizedThreads = normalizeIdentityValues(threads);
  const normalizedSupersedes = normalizeIdentityValues(supersedes);
  const sourcePath = deterministicMemorySourcePath(room, title, body, normalizedThreads, normalizedSupersedes);
  const params: Record<string, unknown> = {
    room, kind: "memory", title, body, source_path: sourcePath,
    threads: normalizedThreads,
    supersedes: normalizedSupersedes,
    backup: false,
  };
  try {
    const receipt = await transport.request("remember", params, {
      signal: signal || undefined, timeoutMs: WRITE_TIMEOUT_MS, settleDefinitively: true,
    });
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
      evictRustRememberTransport(executable, transport);
      return unknownWriteReceipt(new RustTransportOutcomeUnknownError(), sourcePath, await reconcileRustMemory(room, sourcePath, signal));
    }
    const value = receipt as Record<string, unknown>;
    if (typeof value.memory_id !== "number" || typeof value.room !== "string"
      || typeof value.source_path !== "string" || value.durable !== true
      || value.authority !== "postgres" || !Array.isArray(value.warnings)
      || !value.warnings.every((warning) => typeof warning === "string")) {
      evictRustRememberTransport(executable, transport);
      return unknownWriteReceipt(new RustTransportOutcomeUnknownError(), sourcePath, await reconcileRustMemory(room, sourcePath, signal));
    }
    return { ok: true, ...value, id: value.memory_id, sourcePath: value.source_path };
  } catch (error) {
    if (isOutcomeUnknownError(error)) {
      evictRustRememberTransport(executable, transport);
      return unknownWriteReceipt(error, sourcePath, await reconcileRustMemory(room, sourcePath, signal));
    }
    if (!transport.usable) evictRustRememberTransport(executable, transport);
    if (error instanceof RustTransportError) {
      return { ok: false, error: error.message, code: error.code, retryable: error.retryable, details: error.details };
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function writeRustLesson({ room, kind, title, body, fields, backup, signal }) {
  const executable = discoverRustExecutable();
  const transport = rustRememberTransport();
  if (!transport) return null;
  const params: Record<string, unknown> = {
    room, kind, title, body, shape: fields.shape ?? null, voice: fields.voice ?? null,
    scope: fields.scope ?? null, project: fields.project ?? null,
    proofPattern: fields.proofPattern ?? null, triggerContext: fields.triggerContext ?? null,
    tags: Array.isArray(fields.tags) ? fields.tags : [], backup,
  };
  try {
    const receipt = await transport.request("remember", params, {
      signal: signal || undefined, timeoutMs: WRITE_TIMEOUT_MS, settleDefinitively: true,
    });
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
      evictRustRememberTransport(executable, transport);
      return unknownLessonReceipt();
    }
    const value = receipt as Record<string, unknown>;
    if (typeof value.lesson_id !== "number" || value.kind !== kind || value.durable !== true
      || value.authority !== "postgres" || !Array.isArray(value.warnings)
      || !value.warnings.every((warning) => typeof warning === "string")) {
      evictRustRememberTransport(executable, transport);
      return unknownLessonReceipt();
    }
    return { ok: true, ...value, id: value.lesson_id };
  } catch (error) {
    if (isOutcomeUnknownError(error)) {
      evictRustRememberTransport(executable, transport);
      return {
        ok: false,
        error: "Rust lesson write outcome is unknown after dispatch",
        code: "outcome_unknown",
        outcome: "unknown",
        retryable: true,
        details: error instanceof RustTransportError ? error.details : undefined,
      };
    }
    if (!transport.usable) evictRustRememberTransport(executable, transport);
    if (error instanceof RustTransportError) {
      return { ok: false, error: error.message, code: error.code, retryable: error.retryable, details: error.details };
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
async function writeRustAnamnesis({ room, payload, signal }) {
  const executable = discoverRustExecutable();
  const transport = rustRememberTransport();
  if (!transport || !executable) return null;
  const operation = payload?.operation;
  const params = { room, ...payload };
  try {
    const receipt = await transport.request("anamnesis_write", params, {
      signal: signal || undefined, timeoutMs: WRITE_TIMEOUT_MS, settleDefinitively: true,
    });
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
      evictRustRememberTransport(executable, transport);
      return { ok: false, error: "Rust anamnesis write outcome is unknown after dispatch", code: "outcome_unknown", outcome: "unknown", retryable: true };
    }
    const value = receipt as Record<string, unknown>;
    if (value.ok !== true || value.operation !== operation || value.room !== room
      || typeof value.title !== "string"
      || (operation === "add" && value.kind !== "pillar" && value.kind !== "cycle")
      || (operation === "append-rep" && (!Number.isInteger(value.repNumber) || Number(value.repNumber) < 1))
      || value.durable !== true || value.authority !== "postgres"
      || !Array.isArray(value.warnings) || !value.warnings.every((warning) => typeof warning === "string")) {
      evictRustRememberTransport(executable, transport);
      return { ok: false, error: "Rust anamnesis write outcome is unknown after dispatch", code: "outcome_unknown", outcome: "unknown", retryable: true };
    }
    return { ok: true, ...value };
  } catch (error) {
    if (isOutcomeUnknownError(error)) {
      evictRustRememberTransport(executable, transport);
      return {
        ok: false, error: "Rust anamnesis write outcome is unknown after dispatch",
        code: "outcome_unknown", outcome: "unknown", retryable: true,
        details: error instanceof RustTransportError ? error.details : undefined,
      };
    }
    if (!transport.usable) evictRustRememberTransport(executable, transport);
    if (error instanceof RustTransportError) {
      return { ok: false, error: error.message, code: error.code, retryable: error.retryable, details: error.details };
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function closeRustRememberTransports() {
  for (const [executable, transport] of rustRememberTransports) {
    rustRememberTransports.delete(executable);
    transport.close();
  }
}

function refuseToolResult(error) {
  const result = { ok: false, error };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    details: result,
  };
}

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
        const recalled = await recallWithRouting(effectiveRoomDir, room, params.query, { signal: _signal });
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
    description: "Write a durable memory or lesson to the Solarisael substrate. In Full House, PostgreSQL is authoritative; source paths are provenance or backup, not the memory body. For memory, preserve retrieval-bearing concrete facts. Do not replace the event with only a conclusion or transcript pointer. The memory must stand alone.",
    parameters: z.object({
      title: z.string().describe("Short title."),
      body: z.string().describe("Markdown body. In Full House this complete body is stored authoritatively in PostgreSQL; a source path cannot replace it. For memory: preserve the names, observable details, actions, boundaries, and meaning needed for future recognition. The body must stand alone; a transcript may be provenance but cannot carry the only substance. For lessons: the lesson text."),
      kind: z.enum(["memory", "coding-lesson", "project-lesson", "writing-lesson", "audio-lesson"]).optional()
        .describe("Destination store. memory (default): a thing that happened. coding-lesson: a reusable code rule with a proof pattern. project-lesson: a project-wide rule (requires 'project'). writing-lesson: a prose-taste rule (register, voice, wit mechanics). audio-lesson: an audio-pipeline rule."),
      threads: z.array(z.string()).optional().describe("memory only: thread keys, 'concept / variant / variant'."),
      supersedes: z.array(z.string()).optional().describe("memory only: positive numeric memory IDs replaced by this write; old rows remain recoverable but lose retrieval authority."),
      shape: z.string().optional().describe("lesson kinds: shape taxonomy value (e.g. process, naming, refusal)."),
      voice: z.string().optional().describe("coding/writing lessons: voice (e.g. craft, room-style)."),
      scope: z.string().optional().describe("coding-lesson: scope (shared or a room name)."),
      project: z.string().optional().describe("project-lesson (required) or coding-lesson: project name."),
      proofPattern: z.string().optional().describe("coding/project lessons: the proof pattern."),
      triggerContext: z.string().optional().describe("lesson kinds: when this lesson should fire."),
      tags: z.array(z.string()).optional().describe("lesson kinds: tags."),
    }),
    approval: "write",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
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
        const invalidSupersedes = (params.supersedes || []).filter((memoryId) => !/^[1-9]\d*$/.test(memoryId));
        if (invalidSupersedes.length > 0) return refuse(`supersedes accepts positive numeric memory IDs; invalid: ${invalidSupersedes.join(", ")}`);
        const rustConfigured = Boolean(discoverRustExecutable());
        const result = rustConfigured
          ? await writeRustMemory({ room, title: params.title, body: params.body, threads: params.threads || [], supersedes: [...new Set(params.supersedes || [])], signal })
          : await writeSessionMemory({ sharedRoot, room, title: params.title, body: params.body, backup: false, threads: params.threads || [], supersedes: [...new Set(params.supersedes || [])] });
        return { isError: !result.ok, content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
      }

      if (Array.isArray(params.threads) && params.threads.length > 0) return refuse("threads are memory-only; lesson stores do not take threads");
      if (Array.isArray(params.supersedes) && params.supersedes.length > 0) return refuse("supersedes is memory-only; lesson stores do not supersede memory rows");
      const store = REMEMBER_STORES[kind];
      const fields = {
        shape: params.shape,
        voice: params.voice,
        scope: params.scope,
        project: params.project,
        proofPattern: params.proofPattern,
        triggerContext: params.triggerContext,
        tags: params.tags,
      };
      const built = buildStoreArgs(kind, store, fields);
      if (!built.ok) return refuse(built.error);
      const rustConfigured = Boolean(discoverRustExecutable());
      const rustFields = {
        ...fields,
        scope: kind === "coding-lesson" ? (params.scope || "shared") : params.scope,
        voice: kind === "writing-lesson" ? (params.voice || "general") : params.voice,
      };
      const result = rustConfigured
        ? await writeRustLesson({ room, kind, title: params.title, body: params.body, fields: rustFields, backup: !store.noBackup, signal })
        : await writeLessonStore({ sharedRoot, store, title: params.title, body: params.body, extraArgs: built.args });
      return { isError: !result.ok, content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
    },
  });

  pi.registerTool({
    name: "delete_lesson",
    label: "Solarisael Delete Lesson (Destructive)",
    description: [
      "Permanently delete exactly one coding or project lesson by numeric ID.",
      "REQUIRES the exact current expected title; a mismatch or unknown ID refuses without deleting.",
      "This is destructive and requires write approval. Never use it for broad cleanup.",
    ].join("\n"),
    parameters: z.object({
      kind: z.enum(["coding-lesson", "project-lesson"]).describe("Which allowlisted lesson table: coding-lesson or project-lesson."),
      id: z.string().describe("Exact positive numeric lesson ID (digits only)."),
      expectedTitle: z.string().describe("Exact current title required as a deletion guard (must be non-empty)."),
    }),
    approval: "write",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { sharedRoot, effectiveRoomDir } = roomContext(ctx.cwd);
      const result = await deleteLesson({
        sharedRoot,
        effectiveRoomDir,
        kind: params.kind,
        id: params.id,
        expectedTitle: params.expectedTitle,
      });
      return {
        isError: !result.ok,
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "update_lesson",
    label: "Solarisael Update Lesson",
    description: [
      "Update exactly one coding or project lesson while preserving its ID.",
      "REQUIRES the exact current expected title; a mismatch or unknown ID refuses without updating.",
      "This is a guarded write and requires write approval.",
    ].join("\n"),
    parameters: z.object({
      kind: z.enum(["coding-lesson", "project-lesson"]).describe("Which allowlisted lesson table."),
      id: z.string().describe("Exact positive numeric lesson ID (digits only)."),
      expectedTitle: z.string().describe("Exact current title required as an update guard (must be non-empty)."),
      title: z.string().optional().describe("Replacement title."),
      body: z.string().optional().describe("Replacement lesson body; sent through stdin."),
      shape: z.string().optional().describe("Lesson shape taxonomy value."),
      triggerContext: z.string().optional().describe("When the lesson should trigger."),
      tags: z.array(z.string()).optional().describe("Replacement lesson tags."),
      voice: z.string().optional().describe("Coding lesson voice."),
      scope: z.string().optional().describe("Coding lesson scope."),
      project: z.string().optional().describe("Coding/project lesson project."),
      proofPattern: z.string().optional().describe("Coding/project lesson proof pattern."),
      negationOf: z.string().optional().describe("Coding lesson ID this lesson negates; omit to preserve."),
      clearNegationOf: z.boolean().optional().describe("Clear the coding lesson's negation link; mutually exclusive with negationOf."),
    }),
    approval: "write",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!/^[1-9]\d*$/.test(String(params.id || ""))) return refuseToolResult("id must be a positive numeric ID");
      if (typeof params.expectedTitle !== "string" || params.expectedTitle.length === 0) {
        return refuseToolResult("expectedTitle must be non-empty and match the current title exactly");
      }
      const patchFields = ["title", "body", "shape", "triggerContext", "tags", "voice", "scope", "project", "proofPattern", "negationOf", "clearNegationOf"];
      const patch = Object.fromEntries(patchFields
        .filter((key) => Object.prototype.hasOwnProperty.call(params, key) && params[key] !== undefined)
        .map((key) => [key, params[key]]));
      if (patch.clearNegationOf === true) {
        if (patch.negationOf !== undefined) return refuseToolResult("negationOf and clearNegationOf are mutually exclusive");
        patch.negationOf = null;
      }
      delete patch.clearNegationOf;
      if (Object.keys(patch).length === 0) return refuseToolResult("at least one update field is required");
      if (params.kind === "project-lesson" && (patch.voice !== undefined || patch.scope !== undefined || patch.negationOf !== undefined)) {
        return refuseToolResult("project-lesson does not accept voice, scope, or negationOf");
      }
      const { sharedRoot, effectiveRoomDir } = roomContext(ctx.cwd);
      const result = await updateLesson({
        sharedRoot,
        effectiveRoomDir,
        kind: params.kind,
        id: params.id,
        expectedTitle: params.expectedTitle,
        patch,
      });
      return {
        isError: !(result.ok === true && result.updated === true),
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
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
    description: "Update safe room agency fields: operator and embodiedSpirit. Also refreshes active_spirit.md.",
    parameters: z.object({
      operator: z.string().optional().describe("Operator display name."),
      embodiedSpirit: z.string().optional().describe("The room identity's true/display name."),
    }),
    approval: "write",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { room, spirit, effectiveRoomDir } = roomContext(ctx.cwd);
      const current = await loadRoomState(effectiveRoomDir, room, spirit);
      const embodiedSpirit = params.embodiedSpirit === undefined
        ? null
        : normalizeSpiritName(params.embodiedSpirit);
      if (params.embodiedSpirit !== undefined && !embodiedSpirit) {
        return refuseToolResult("embodiedSpirit must be 1-80 characters and contain no line breaks or '|'");
      }
      const operator = params.operator === undefined ? null : normalizeSpiritName(params.operator);
      if (params.operator !== undefined && !operator) {
        return refuseToolResult("operator must be 1-80 characters and contain no line breaks or '|'");
      }
      const next = await saveRoomState(effectiveRoomDir, {
        ...current,
        ...(operator ? { operator } : {}),
        ...(embodiedSpirit ? { embodiedSpirit, agentName: embodiedSpirit, lastSpiritChangeAt: new Date().toISOString() } : {}),
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
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const { sharedRoot } = roomContext(ctx?.cwd);
      const result = await laneStatus();
      const substrate = await substrateHealth(sharedRoot);
      const status = { ...result, substrate };
      return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }], details: status };
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
  pi.registerTool({
    name: "anamnesis",
    label: "Solarisael Anamnesis",
    description: "Read the Anamnesis Cabinet as bounded counsel for this room.",
    parameters: z.object({
      mode: z.enum(["wake", "consult"]),
      query: z.string().optional(),
      limit: z.number().optional(),
    }),
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { room, effectiveRoomDir } = roomContext(ctx.cwd);
      const mode = params.mode;
      if (mode === "consult" && !String(params.query || "").trim()) {
        return refuseToolResult("consult requires a non-empty query");
      }
      const result = await queryAnamnesis(effectiveRoomDir, room, {
        mode,
        ...(mode === "consult" ? { query: params.query } : {}),
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
      });
      const counsel = result.ok ? formatAnamnesisContext(result, { automatic: false }) : "";
      const output = { ...result, counsel };
      return {
        isError: !result.ok,
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        details: { room, ...output },
      };
    },
  });

  pi.registerTool({
    name: "anamnesis_write",
    label: "Solarisael Anamnesis Write",
    description: "Write an Anamnesis Cabinet drawer or append a lived repetition; writer refusals remain final.",
    parameters: z.object({
      operation: z.enum(["add", "append-rep"]),
      kind: z.enum(["pillar", "cycle"]).optional(),
      fidelity: z.enum(["record", "raw-material"]).optional(),
      activation: z.enum(["wake", "fork"]).optional(),
      dormant: z.boolean().optional(),
      title: z.string(),
      shape: z.string().optional(),
      ramp: z.string().optional(),
      counsel: z.string().optional(),
      peak: z.string().optional(),
      beginning: z.string().optional(),
      verifyNote: z.string().optional(),
      canon: z.array(z.string()).optional(),
      sourcePaths: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
      allowEmptyCycle: z.boolean().optional(),
      seedRep: z.object({
        number: z.number(),
        occurredOn: z.string().optional(),
        howItWent: z.string(),
        portalPull: z.string(),
        lighter: z.string(),
      }).optional(),
      repNumber: z.number().optional(),
      occurredOn: z.string().optional(),
      howItWent: z.string().optional(),
      portalPull: z.string().optional(),
      lighter: z.string().optional(),
    }),
    approval: "write",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { room, sharedRoot } = roomContext(ctx.cwd);
      const payload = { ...params };
      if (params.operation === "add") {
      if (params.kind === "pillar" && params.seedRep !== undefined) {
        return refuseToolResult("pillars cannot include seedRep");
      }
      if (!params.kind || !params.fidelity || !params.activation || !String(params.ramp || "").trim()) {
        return refuseToolResult("add requires kind, fidelity, activation, and ramp");
      }
        const rust = await writeRustAnamnesis({ room, payload, signal: _signal });
        const result = rust || await writeAnamnesisDrawer({ sharedRoot, room, payload });
        return { isError: !result.ok, content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
      }
      if (!Number.isInteger(params.repNumber) || params.repNumber < 1 || !String(params.howItWent || "").trim() || !String(params.portalPull || "").trim() || !String(params.lighter || "").trim() || !Array.isArray(params.sourcePaths)) {
        return refuseToolResult("append-rep requires integer repNumber, howItWent, portalPull, lighter, and sourcePaths");
      }
      const rust = await writeRustAnamnesis({ room, payload, signal: _signal });
      const result = rust || await appendAnamnesisRep({ sharedRoot, room, payload });
      return { isError: !result.ok, content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
    },
  });
}
