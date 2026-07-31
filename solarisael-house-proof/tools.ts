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
import { laneStatus } from "./routing.ts";
import { familiarStatus } from "./familiars.ts";
import { dispatchHouse } from "./dispatch.ts";
import { REMEMBER_STORES, buildStoreArgs } from "./stores.ts";
import { WRITE_TIMEOUT_MS } from "./constants.ts";
import {
  createToolRenderers,
  emitToolUpdate,
  normalizeToolResponse,
  toolThrown,
} from "./feedback.ts";
import {
  GIGA_OMP_ROOM_BINDING,
  flushGigaTurnsDetached,
  gigaTransportFailure,
  requestGigaCandidateList,
  requestGigaHealth,
  requestGigaQueueMaintenance,
  requestGigaPromote,
  requestGigaReview,
  resolveGigaSourceRefsFromLedger,
  type GigaCandidate,
  type GigaPromotionTarget,
  type GigaPromotionRequest,
  type GigaSafeReviewState,
} from "../giga.ts";

const rustRememberTransports = new Map<string, RustJsonlTransport>();
const LANE_STATUS_HEALTH_TIMEOUT_MS = 3_000;

const defaultGigaPromotionOperations = Object.freeze({
  requestGigaCandidateList,
  resolveGigaSourceRefsFromLedger,
  requestGigaPromote,
});
let gigaPromotionOperations = { ...defaultGigaPromotionOperations };

export const __gigaPromotionTest = Object.freeze({
  setOperations(overrides: Partial<typeof defaultGigaPromotionOperations>) {
    gigaPromotionOperations = { ...defaultGigaPromotionOperations, ...overrides };
  },
  resetOperations() {
    gigaPromotionOperations = { ...defaultGigaPromotionOperations };
  },
});


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

function deterministicMemorySourcePath(room: string, title: string, body: string, threads: unknown[], continues: unknown[], supersedes: unknown[]): string {
  const canonical = JSON.stringify({ room, title, body, threads, continues, supersedes });
  const digest = createHash("sha256").update(canonical).digest("hex").slice(0, 24);

  const baseline = memorySourcePath(title, new Date(0));
  return baseline.replace(/^memory\/omp_[^_]+_/, `memory/omp_${digest}_`);
}

function rustFailureReceipt(error: RustTransportError): Record<string, unknown> {
  const upstreamDetails = error.details && typeof error.details === "object" && !Array.isArray(error.details)
    ? error.details as Record<string, unknown>
    : { upstream_details: error.details ?? null };
  const stderr = error.stderr.slice(0, 4096);
  const evidence = Array.isArray(upstreamDetails.evidence) ? [...upstreamDetails.evidence] : [];
  if (stderr) {
    evidence.push({
      source: "rust_stderr",
      text: stderr,
      truncated: error.stderr.length > stderr.length,
    });
  }
  return {
    ok: false,
    error: error.message,
    code: error.code,
    retryable: error.retryable,
    details: { ...upstreamDetails, evidence },
  };
}

function unknownOutcomeDetails(error: unknown): Record<string, unknown> {
  const source = error && typeof error === "object" ? error as { details?: unknown; cause?: unknown } : {};
  const details = source.details && typeof source.details === "object" && !Array.isArray(source.details)
    ? source.details as Record<string, unknown>
    : source.details === undefined ? {} : { upstream_details: source.details };
  if (!(source.cause instanceof Error)) return details;
  return {
    ...details,
    cause: { name: source.cause.name, message: source.cause.message },
  };
}
function isOutcomeUnknownError(error: unknown): boolean {
  return error instanceof RustTransportOutcomeUnknownError;
}

async function reconcileRustMemory(room: string, sourcePath: string, signal?: AbortSignal) {
  try {
    const recalled = await recallWithRouting("", room, sourcePath, { signal, temporalDecay: false });
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
    committed: reconciliation.committed,
    reconciled: reconciliation.reconciled,
    details: unknownOutcomeDetails(error),
  };
}

function unknownLessonReceipt(error?: unknown): Record<string, unknown> {
  return {
    ok: false,
    error: "Rust lesson write outcome is unknown after dispatch",
    code: "outcome_unknown",
    outcome: "unknown",
    retryable: true,
    details: unknownOutcomeDetails(error),
  };
}

async function writeRustMemory({ room, title, body, threads, continues, supersedes, signal }) {
  const executable = discoverRustExecutable();
  const transport = rustRememberTransport();
  if (!transport) return null;
  const normalizeIdentityValues = (values: unknown) => [
    ...new Set(
      (Array.isArray(values) ? values : [])
        .map(String)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ].sort();

  const normalizedThreads = normalizeIdentityValues(threads);
  const normalizedContinues = (Array.isArray(continues) ? continues : [])
    .map((continuation) => ({
      thread: String(continuation.thread).trim(),
      previousMemoryId: String(continuation.previousMemoryId),
    }))
    .sort((left, right) => left.thread.localeCompare(right.thread));
  const normalizedSupersedes = normalizeIdentityValues(supersedes);

  const sourcePath = deterministicMemorySourcePath(
    room,
    title,
    body,
    normalizedThreads,
    normalizedContinues,
    normalizedSupersedes,
  );
  const params: Record<string, unknown> = {
    room,
    kind: "memory",
    title,
    body,
    source_path: sourcePath,
    threads: normalizedThreads,
    continues: normalizedContinues,
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
      return rustFailureReceipt(error);
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
        details: unknownOutcomeDetails(error),
      };
    }
    if (!transport.usable) evictRustRememberTransport(executable, transport);
    if (error instanceof RustTransportError) {
      return rustFailureReceipt(error);
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function unknownAnamnesisReceipt(error?: unknown): Record<string, unknown> {
  return {
    ok: false,
    error: "Rust anamnesis write outcome is unknown after dispatch",
    code: "outcome_unknown",
    outcome: "unknown",
    retryable: true,
    details: unknownOutcomeDetails(error),
  };
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
      return unknownAnamnesisReceipt();
    }
    const value = receipt as Record<string, unknown>;
    if (value.ok !== true || value.operation !== operation || value.room !== room
      || typeof value.title !== "string"
      || (operation === "add" && value.kind !== "pillar" && value.kind !== "cycle")
      || (operation === "append-rep" && (!Number.isInteger(value.repNumber) || Number(value.repNumber) < 1))
      || value.durable !== true || value.authority !== "postgres"
      || !Array.isArray(value.warnings) || !value.warnings.every((warning) => typeof warning === "string")) {
      evictRustRememberTransport(executable, transport);
      return unknownAnamnesisReceipt();
    }
    return { ok: true, ...value };
  } catch (error) {
    if (isOutcomeUnknownError(error)) {
      evictRustRememberTransport(executable, transport);
      return unknownAnamnesisReceipt(error);
    }
    if (!transport.usable) evictRustRememberTransport(executable, transport);
    if (error instanceof RustTransportError) {
      return rustFailureReceipt(error);
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

function gigaToolFailure(error) {
  const failure = gigaTransportFailure(error);
  const result = {
    ok: false,
    status: "error",
    code: failure.code,
    error: failure.message,
    message: failure.message,
    retryable: failure.retryable,
    details: failure.details ?? {},
  };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    details: result,
  };
}

function gigaCandidateRefusal(error, room, candidateId) {
  const result = {
    ok: false,
    status: "error",
    code: "giga_review_refused",
    error,
    message: error,
    retryable: false,
    details: { room, candidate_id: candidateId },
  };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    details: result,
  };
}

function gigaPromotionRefusal(error, room, candidateId) {
  const result = {
    ok: false,
    status: "error",
    code: "giga_promotion_refused",
    error,
    message: error,
    retryable: false,
    details: { room, candidate_id: candidateId },
  };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    details: result,
  };
}

function safeGigaTransition(previousState, newState) {
  return (previousState === "unreviewed"
      && (newState === "in_review" || newState === "dismissed" || newState === "expired"))
    || (previousState === "in_review"
      && (newState === "dismissed" || newState === "unresolved" || newState === "curio"))
    || (previousState === "unresolved" && newState === "in_review")
    || (previousState === "curio" && (newState === "dismissed" || newState === "expired"));
}

function registerHouseTool(pi, definition) {
  const execute = definition.execute;
  const renderers = createToolRenderers(definition.label);
  pi.registerTool({
    ...definition,
    ...renderers,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      emitToolUpdate(onUpdate, definition.name);
      try {
        return normalizeToolResponse(await execute(toolCallId, params, signal, onUpdate, ctx), definition.name);
      } catch (error) {
        return toolThrown(error, definition.name);
      }
    },
  });
}

export function registerSolarisaelTools(pi) {
  const z = pi.zod;

  registerHouseTool(pi, {
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
        const recalled = await recallWithRouting(effectiveRoomDir, room, params.query, { signal: _signal, temporalDecay: false });
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

  registerHouseTool(pi, {
    name: "remember",
    label: "Solarisael Remember",
    description: "Write a durable memory or lesson to the Solarisael substrate. In Full House, PostgreSQL is authoritative; source paths are provenance or backup, not the memory body. For memory, preserve retrieval-bearing concrete facts. Do not replace the event with only a conclusion or transcript pointer. The memory must stand alone.",
    parameters: z.object({
      title: z.string().describe("Short title."),
      body: z.string().describe("Markdown body. In Full House this complete body is stored authoritatively in PostgreSQL; a source path cannot replace it. For memory: preserve the names, observable details, actions, boundaries, and meaning needed for future recognition. The body must stand alone; a transcript may be provenance but cannot carry the only substance. For lessons: the lesson text."),
      kind: z.enum(["memory", "coding-lesson", "project-lesson", "writing-lesson", "audio-lesson"]).optional()
        .describe("Destination store. memory (default): a thing that happened. coding-lesson: a reusable code rule with a proof pattern. project-lesson: a project-wide rule (requires 'project'). writing-lesson: a prose-taste rule (register, voice, wit mechanics). audio-lesson: an audio-pipeline rule."),
      room: z.enum(["house"]).optional()
        .describe("memory only: omit to write to this room. 'house' writes to the House commons — durable work any room can use. A sibling room is never a valid target."),
      threads: z.array(z.string()).optional().describe("memory only: thread keys, 'concept / variant / variant'."),
      supersedes: z.array(z.string()).optional().describe("memory only: positive numeric memory IDs replaced by this write; old rows remain recoverable but lose retrieval authority."),
      continues: z.array(z.object({
        thread: z.string(),
        previousMemoryId: z.string().regex(/^[1-9]\d*$/),
      })).optional().describe("memory only: predecessor edges, one per thread; thread must also appear in threads."),
      shape: z.string().optional().describe("lesson kinds: shape taxonomy value (e.g. process, naming, refusal)."),
      voice: z.string().optional().describe("coding/writing lessons: voice (e.g. craft, room-style)."),
      scope: z.string().optional().describe("coding-lesson: scope (house or a room name)."),
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
        const targetRoom = params.room === "house" ? "house" : room;
        const threads = [];
        const seenThreads = new Set();

        for (const rawThread of params.threads || []) {
          const thread = rawThread.trim();
          if (!thread) return refuse("threads must be nonblank");

          if (!seenThreads.has(thread)) {
            seenThreads.add(thread);
            threads.push(thread);
          }
        }

        const continues = [];
        const continuedThreads = new Set();

        for (const continuation of params.continues || []) {
          if (!/^[1-9]\d*$/.test(continuation.previousMemoryId)) {
            return refuse("continues previousMemoryId must be a positive PostgreSQL BIGINT");
          }
          if (BigInt(continuation.previousMemoryId) > 9223372036854775807n) {
            return refuse("continues previousMemoryId must fit a positive PostgreSQL BIGINT");
          }

          const thread = continuation.thread.trim();
          if (!thread) return refuse("continues thread must be nonblank");
          if (continuedThreads.has(thread)) {
            return refuse(`continues must contain at most one entry per thread: ${thread}`);
          }
          if (!seenThreads.has(thread)) {
            return refuse(`continues thread must also be present in threads: ${thread}`);
          }

          continuedThreads.add(thread);
          continues.push({ thread, previousMemoryId: continuation.previousMemoryId });
        }

        const invalidSupersedes = (params.supersedes || [])
          .filter((memoryId) => !/^[1-9]\d*$/.test(memoryId));
        if (invalidSupersedes.length > 0) {
          return refuse(`supersedes accepts positive numeric memory IDs; invalid: ${invalidSupersedes.join(", ")}`);
        }

        const rustConfigured = Boolean(discoverRustExecutable());
        const result = rustConfigured
          ? await writeRustMemory({
            room: targetRoom,
            title: params.title,
            body: params.body,
            threads,
            continues,
            supersedes: [...new Set(params.supersedes || [])],
            signal,
          })
          : await writeSessionMemory({
            sharedRoot,
            room: targetRoom,
            title: params.title,
            body: params.body,
            backup: false,
            threads,
            continues,
            supersedes: [...new Set(params.supersedes || [])],
          });
        return { isError: !result.ok, content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
      }
  
      if (Array.isArray(params.threads) && params.threads.length > 0) return refuse("threads are memory-only; lesson stores do not take threads");
      if (Array.isArray(params.supersedes) && params.supersedes.length > 0) return refuse("supersedes is memory-only; lesson stores do not supersede memory rows");
      if (Array.isArray(params.continues) && params.continues.length > 0) return refuse("continues is memory-only; lesson stores do not link memory threads");
      if (params.room) return refuse("room is memory-only; lesson stores route by scope/project, not room");
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

  registerHouseTool(pi, {
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

  registerHouseTool(pi, {
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

  registerHouseTool(pi, {
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

  registerHouseTool(pi, {
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

  registerHouseTool(pi, {
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

  registerHouseTool(pi, {
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

  registerHouseTool(pi, {
    name: "sleep",
    label: "Solarisael Sleep",
    description: "Close the session by writing one paper boat with backup enabled.",
    parameters: z.object({
      body: z.string().describe("Markdown boat: what happened, for tomorrow, reminders."),
    }),
    approval: "write",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { room, sharedRoot } = roomContext(ctx.cwd);
      // Sleep is the deliberate session boundary: classify whatever the buffer still holds
      // so the closing batch is not stranded until the next session's shutdown.
      flushGigaTurnsDetached(ctx);
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

  registerHouseTool(pi, {
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
      const substrate = await substrateHealth(sharedRoot, LANE_STATUS_HEALTH_TIMEOUT_MS);
      const status = { ...result, substrate };
      return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }], details: status };
    },
  });

  registerHouseTool(pi, {
    name: "familiar_status",
    label: "Solarisael Familiar Status",
    description: [
      "Load and validate this room's familiar spellbook.",
      "The canonical file is familiars/spellbook.json; familiars/litters.json is accepted as a room-level alias.",
    ].join("\n"),
    parameters: z.object({}),
    approval: "read",
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const { effectiveRoomDir } = roomContext(ctx.cwd);
      const result = await familiarStatus(effectiveRoomDir);
      return {
        isError: !result.ok,
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  registerHouseTool(pi, {
    name: "familiar_dispatch",
    label: "Solarisael Familiar Dispatch",
    description: [
      "Resolve a named familiar or alias from this room's spellbook and build its bounded OMP task packet.",
      "The familiar binds identity to an existing worker lane. This tool validates and packages; the main model still spawns explicitly.",
    ].join("\n"),
    parameters: z.object({
      familiar: z.string().describe("Familiar id, name, or alias from this room's spellbook."),
      task: z.string().describe("Exact work packet the familiar should execute."),
      target: z.string().optional().describe("Exact target files/symbols/non-goals when known."),
      context: z.array(z.object({
        mode: z.enum(["exact", "gist", "image-ok", "retrieve-only"]).describe("Context treatment policy for this fragment."),
        source: z.string().optional().describe("Source path, URI, or handle for this context fragment."),
        content: z.string().optional().describe("Small inline context fragment, when safe."),
        reason: z.string().optional().describe("Why this fragment is included."),
      })).optional().describe("Context fragments tagged by exact/gist/image/retrieve-only policy."),
      acceptance: z.array(z.string()).optional().describe("Observable acceptance checks the familiar must satisfy."),
      risk: z.enum(["low", "medium", "high"]).optional().describe("Dispatch risk label for receipt/context."),
    }),
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { effectiveRoomDir } = roomContext(ctx.cwd);
      const result = await dispatchHouse(effectiveRoomDir, params);
      return {
        isError: !result.ok,
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  registerHouseTool(pi, {
    name: "house_dispatch",
    label: "Solarisael House Dispatch",
    description: [
      "Resolve exactly one raw worker lane or room familiar and build a task-tool-ready spawn packet.",
      "The returned spawnPacket.args can be passed directly to OMP's task tool. Spawning remains an explicit main-model action.",
      "Runtime models come from the selected agent definition; per-dispatch model overrides are not supported by current OMP.",
    ].join("\n"),
    parameters: z.object({
      lane: z.string().optional().describe("Worker lane selector. Mutually exclusive with familiar."),
      familiar: z.string().optional().describe("Room familiar id, name, or alias. Mutually exclusive with lane."),
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
    }),
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { effectiveRoomDir } = roomContext(ctx.cwd);
      const result = await dispatchHouse(effectiveRoomDir, params);
      return {
        isError: !result.ok,
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  registerHouseTool(pi, {
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

  registerHouseTool(pi, {
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
  registerHouseTool(pi, {
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

  registerHouseTool(pi, {
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

  registerHouseTool(pi, {
    name: "giga_candidate_list",
    label: "GIGA Candidate List",
    description: "List Stage 1 GIGA candidates stored for the current room. The room is derived from trusted OMP context and cannot be supplied by the caller.",
    parameters: z.object({
      review_state: z.enum(["unreviewed", "in_review", "dismissed", "unresolved", "curio", "expired"]).optional(),
      limit: z.number().optional(),
    }),
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { room } = roomContext(ctx.cwd);
      try {
        const result = await requestGigaCandidateList(room, {
          ...(params.review_state === undefined ? {} : { reviewState: params.review_state }),
          ...(params.limit === undefined ? {} : { limit: params.limit }),
          signal: _signal,
        });
        const crossRoom = result.candidates.find((candidate) => candidate.room !== room);
        if (crossRoom) {
          return gigaCandidateRefusal("candidate list contained a cross-room record", room, crossRoom.candidate_id);
        }
        const output = { ok: true, room, candidates: result.candidates };
        return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          details: output,
        };
      } catch (error) {
        return gigaToolFailure(error);
      }
    },
  });

  registerHouseTool(pi, {
    name: "giga_health",
    label: "GIGA Aggregate Health",
    description: "Read aggregate GIGA queue, store, processing, failure, and candidate health. This does not start GIGA when the integration is disabled.",
    parameters: z.object({}),
    approval: "read",
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const { room } = roomContext(ctx.cwd);
      try {
        const result = await requestGigaHealth(room, { signal: _signal });
        const healthy = result.enabled && result.store_healthy;
        const output = { ok: healthy, ...result };
        return {
          isError: !healthy,
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          details: output,
        };
      } catch (error) {
        return gigaToolFailure(error);
      }
    },
  });
  registerHouseTool(pi, {
    name: "giga_queue_maintenance",
    label: "GIGA Queue Maintenance",
    description: "Inspect or purge disposable stuck Stage 1 GIGA work for the current room. Purge removes only pending, failed, or lease-expired running events with no attached candidates or review resonance; durable memories, lessons, candidates, and review history are preserved.",
    parameters: z.object({
      operation: z.enum(["check", "purge_stuck"]),
    }),
    approval: "write",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { room } = roomContext(ctx.cwd);
      try {
        const result = await requestGigaQueueMaintenance(room, params.operation, {
          signal: _signal,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      } catch (error) {
        return gigaToolFailure(error);
      }
    },
  });


  registerHouseTool(pi, {
    name: "giga_review",
    label: "GIGA Candidate Review",
    description: "Apply a non-authority Stage 1 review transition to a candidate in the current room. Room, reviewer, previous state, authorization, and exact sources are derived locally and cannot be supplied by the caller.",
    parameters: z.object({
      candidate_id: z.string(),
      new_state: z.enum(["in_review", "dismissed", "unresolved", "curio", "expired"]),
      reason: z.string(),
    }),
    approval: "write",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { room, spirit } = roomContext(ctx.cwd);
      const candidateId = params.candidate_id;
      const reason = params.reason.trim();
      if (candidateId !== candidateId.trim() || !reason) {
        return gigaCandidateRefusal("candidate_id must be exact and reason must be non-empty", room, candidateId);
      }

      let candidate: GigaCandidate | undefined;
      try {
        const listed = await requestGigaCandidateList(room, { limit: 200, signal: _signal });
        candidate = listed.candidates.find((item) => item.candidate_id === candidateId);
      } catch (error) {
        return gigaToolFailure(error);
      }
      if (!candidate) {
        return gigaCandidateRefusal("candidate was not found in the current room", room, candidateId);
      }
      if (candidate.room !== room) {
        return gigaCandidateRefusal("cross-room candidate review is forbidden", room, candidateId);
      }
      if (
        candidate.review_state === "promoted"
        || candidate.review_state === "merged"
        || candidate.review_state === "corrected"
        || candidate.review_state === "superseded"
      ) {
        return gigaCandidateRefusal("authority-state candidates cannot be changed through this tool", room, candidateId);
      }
      if (!safeGigaTransition(candidate.review_state, params.new_state)) {
        return gigaCandidateRefusal(
          `transition from ${candidate.review_state} to ${params.new_state} is not available through this tool`,
          room,
          candidateId,
        );
      }
      if (!Array.isArray(candidate.source_refs) || candidate.source_refs.length === 0) {
        return gigaCandidateRefusal("candidate does not retain exact source references", room, candidateId);
      }

      try {
        const result = await requestGigaReview({
          candidate_id: candidate.candidate_id,
          reviewer_id: spirit,
          previous_state: candidate.review_state,
          new_state: params.new_state as GigaSafeReviewState,
          reason,
          authorization_basis: GIGA_OMP_ROOM_BINDING,
          source_refs: candidate.source_refs,
          promotion_target: null,
          merge_target: null,
          merge_source_candidates: [],
          resonance: null,
          reviewed_at: new Date().toISOString(),
        }, { signal: _signal });
        const output = { ok: true, room, ...result };
        return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          details: output,
        };
      } catch (error) {
        return gigaToolFailure(error);
      }
    },
  });

  async function executeGigaPromotion(
    expectedKind: "memory" | "coding_lesson" | "project_lesson",
    params: any,
    signal: AbortSignal | undefined,
    ctx: any,
  ) {
    const { room, spirit, operator } = roomContext(ctx.cwd);
    const candidateId = params.candidate_id;
    if (candidateId !== candidateId.trim() || !candidateId) {
      return gigaPromotionRefusal("candidate_id must be exact and non-empty", room, candidateId);
    }
    if (!params.title.trim() || !params.body.trim()) {
      return gigaPromotionRefusal("explicit edited title and body must be non-empty", room, candidateId);
    }
    let candidate: GigaCandidate | undefined;
    try {
      const listed = await gigaPromotionOperations.requestGigaCandidateList(room, {
        reviewState: "in_review",
        limit: 200,
        signal,
      });
      candidate = listed.candidates.find((item) => item.candidate_id === candidateId);
    } catch (error) {
      return gigaToolFailure(error);
    }
    if (!candidate) {
      return gigaPromotionRefusal("candidate was not found in review in the current room", room, candidateId);
    }
    if (candidate.kind !== expectedKind) {
      return gigaPromotionRefusal("promotion tool kind must match the stored candidate kind", room, candidateId);
    }
    if (candidate.room !== room || candidate.review_state !== "in_review") {
      return gigaPromotionRefusal("candidate is not an in-review current-room record", room, candidateId);
    }
    if (
      typeof candidate.session_id !== "string"
      || !candidate.session_id.trim()
      || !Array.isArray(candidate.project_keys)
      || candidate.project_keys.length > 1
      || !Array.isArray(candidate.source_refs)
      || candidate.source_refs.length === 0
    ) {
      return gigaPromotionRefusal("candidate does not retain valid runtime scope and source identity", room, candidateId);
    }
    const candidateProject = candidate.project_keys[0] ?? null;
    const candidateScope = candidate.scope;
    if (
      !candidateScope
      || typeof candidateScope !== "object"
      || Array.isArray(candidateScope)
      || Object.keys(candidateScope).sort().join(",") !== "project,publication_review_required,room,visibility"
      || candidateScope.room !== room
      || candidateScope.project !== candidateProject
      || candidateScope.visibility !== "private"
      || candidateScope.publication_review_required !== true
    ) {
      return gigaPromotionRefusal("candidate scope does not match trusted room and project authority", room, candidateId);
    }

    let target: GigaPromotionTarget;
    if (expectedKind === "memory") {
      target = {
        kind: "memory",
        payload: { title: params.title, body: params.body, threads: params.threads ?? [] },
      };
    } else if (expectedKind === "coding_lesson") {
      if (candidate.project_keys.length !== 0) {
        return gigaPromotionRefusal("coding lesson promotion cannot widen project scope", room, candidateId);
      }
      target = {
        kind: "coding_lesson",
        payload: {
          title: params.title,
          body: params.body,
          shape: params.shape ?? null,
          proof_pattern: params.proof_pattern ?? null,
          trigger_context: params.trigger_context ?? null,
          tags: params.tags ?? [],
        },
      };
    } else {
      const project = candidate.project_keys[0];
      if (
        candidate.project_keys.length !== 1
        || typeof project !== "string"
        || !project.trim()
        || params.publication_approved !== true
      ) {
        return gigaPromotionRefusal("project lesson promotion requires one stored project key and explicit publication approval", room, candidateId);
      }
      target = {
        kind: "project_lesson",
        payload: {
          title: params.title,
          body: params.body,
          project,
          proof_pattern: params.proof_pattern ?? null,
          trigger_context: params.trigger_context ?? null,
          tags: params.tags ?? [],
        },
      };
    }

    try {
      const sourceRefs = await gigaPromotionOperations.resolveGigaSourceRefsFromLedger(
        ctx,
        room,
        candidate.session_id,
        candidate.source_refs,
        candidate.project_keys,
      );
      const authority = {
        candidate_id: candidate.candidate_id,
        room,
        reviewer_id: spirit,
        operator_identity: operator,
        authorization_basis: GIGA_OMP_ROOM_BINDING,
        source_refs: sourceRefs,
        reviewed_at: new Date().toISOString(),
      };
      const promotionRequest: GigaPromotionRequest = target.kind === "project_lesson"
        ? { ...authority, target, publication_consent: { operator_approved: true, reviewer_approved: true } }
        : { ...authority, target, publication_consent: null };
      const result = await gigaPromotionOperations.requestGigaPromote(promotionRequest, { signal });
      const output = { ok: true, ...result };
      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        details: output,
      };
    } catch (error) {
      return gigaToolFailure(error);
    }
  }

  registerHouseTool(pi, {
    name: "giga_promote_memory",
    label: "GIGA Promote Memory",
    description: "Promote one in-review current-room memory candidate with trusted authority and exact sources.",
    parameters: z.object({
      candidate_id: z.string(),
      title: z.string(),
      body: z.string(),
      threads: z.array(z.string()).optional(),
    }),
    approval: "write",
    execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return executeGigaPromotion("memory", params, signal, ctx);
    },
  });

  registerHouseTool(pi, {
    name: "giga_promote_coding_lesson",
    label: "GIGA Promote Coding Lesson",
    description: "Promote one in-review global coding lesson candidate with trusted authority and exact sources.",
    parameters: z.object({
      candidate_id: z.string(),
      title: z.string(),
      body: z.string(),
      shape: z.string().optional(),
      proof_pattern: z.string().optional(),
      trigger_context: z.string().optional(),
      tags: z.array(z.string()).optional(),
    }),
    approval: "write",
    execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return executeGigaPromotion("coding_lesson", params, signal, ctx);
    },
  });

  registerHouseTool(pi, {
    name: "giga_promote_project_lesson",
    label: "GIGA Promote Project Lesson",
    description: "Promote one in-review project lesson candidate with trusted project scope and explicit publication approval.",
    parameters: z.object({
      candidate_id: z.string(),
      title: z.string(),
      body: z.string(),
      proof_pattern: z.string().optional(),
      trigger_context: z.string().optional(),
      tags: z.array(z.string()).optional(),
      publication_approved: z.boolean(),
    }),
    approval: "write",
    execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return executeGigaPromotion("project_lesson", params, signal, ctx);
    },
  });
}
