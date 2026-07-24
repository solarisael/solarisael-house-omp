export const ADAPTER_API_VERSION = 1;

// Solarisael House — OMP adapter entrypoint.
//
// This file stays where OMP config expects it. The implementation is split into
// shaped modules under ./solarisael-house-proof/ so this door only wires hooks.

import { isFreshConversation, logUnseenConversationTurns } from "./solarisael-house-proof/conversation-log.ts";
import { closeRustRecallTransports, compactRecall, recallWithRouting } from "./solarisael-house-proof/recall.ts";
import { closeRustRememberTransports } from "./solarisael-house-proof/tools.ts";
import { closeRustAnamnesisTransports } from "./solarisael-house-proof/anamnesis.ts";
import { loadHouseQueryRouting } from "./solarisael-house-proof/core.ts";
import { resolveEntities } from "./solarisael-house-proof/entity-resolution.ts";
import { automaticRecallViewport, createRecallViewportSession } from "./solarisael-house-proof/recall-viewport.ts";
import { recordRecallTelemetry } from "./solarisael-house-proof/recall-telemetry.ts";
import {
  applyPromptDirectives,
  roomContext,
  writeActiveSpiritSnapshot,
} from "./solarisael-house-proof/room.ts";
import { catchBoat, formatWakeContext } from "./solarisael-house-proof/substrate.ts";
import { messageText } from "./solarisael-house-proof/text.ts";
import { queryAnamnesis, formatAnamnesisContext } from "./solarisael-house-proof/anamnesis.ts";
import { registerSolarisaelTools } from "./solarisael-house-proof/tools.ts";
import { contextNudge, keywordReminder, processLessonsReminder } from "./solarisael-house-proof/triggers.ts";

const wokenSessions = new Set();
const modelDefaultsApplied = new Set();
const recallViewportSessions = new Map();

const REDACTED = "[REDACTED]";
const DIAGNOSTIC_TEXT_LIMIT = 2_000;
const SENSITIVE_DIAGNOSTIC_KEY = /(?:authorization|cookie|password|secret|token|api[_-]?key|prompt|query|payload|body|stdin|url)/i;

function diagnosticRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : null;
}

function redactDiagnosticText(value: unknown, privateValues: unknown[] = []): string | null {
  if (value == null) return null;
  let text = String(value);
  for (const privateValue of privateValues) {
    const privateText = typeof privateValue === "string" ? privateValue : "";
    if (privateText) text = text.replaceAll(privateText, REDACTED);
  }
  return text
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\b([a-z][a-z\d+.-]*):\/\/[^/\s:@]+(?::[^@\s]*)?@/gi, "$1://[REDACTED]@")
    .replace(/\b(password|secret|token|api[_-]?key|authorization)\s*[=:]\s*\S+/gi, "$1=[REDACTED]")
    .slice(0, DIAGNOSTIC_TEXT_LIMIT);
}

function redactDiagnosticValue(value: unknown, privateValues: unknown[] = [], depth = 0): unknown {
  if (depth >= 6) return "[TRUNCATED]";
  if (typeof value === "string") return redactDiagnosticText(value, privateValues);
  if (Array.isArray(value)) return value.slice(0, 24).map((item) => redactDiagnosticValue(item, privateValues, depth + 1));
  const record = diagnosticRecord(value);
  if (!record) return value;
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [
    key,
    SENSITIVE_DIAGNOSTIC_KEY.test(key) ? REDACTED : redactDiagnosticValue(item, privateValues, depth + 1),
  ]));
}

function automaticContextDiagnostic({
  operation,
  stage,
  error,
  failure,
  route = null,
  requestDispatched,
}: {
  operation: string;
  stage: string;
  error: unknown;
  failure?: unknown;
  route?: Record<string, any> | null;
  requestDispatched: boolean;
}): Record<string, unknown> {
  const privateValues = [route?.recallQuery];
  const source = diagnosticRecord(failure);
  const sourceDetails = diagnosticRecord(source?.details);
  const inherited = redactDiagnosticValue(sourceDetails, privateValues) as Record<string, any> | null;
  const sourceExecution = diagnosticRecord(sourceDetails?.execution);
  const sourceRetryable = source?.retryable ?? sourceDetails?.retryable;
  const childCause = redactDiagnosticValue({
    error: source?.error ?? error,
    code: source?.code,
    signal: source?.signal,
    timed_out: source?.timedOut,
    spawn_error: source?.spawnError,
    fallback: source?.fallback,
    diagnostic: source?.diagnostic,
  }, privateValues);
  const inheritedEvidence = Array.isArray(inherited?.evidence) ? inherited.evidence : [];
  const execution = {
    request_dispatched: typeof sourceExecution?.request_dispatched === "boolean"
      ? sourceExecution.request_dispatched
      : requestDispatched,
    write_outcome: ["not_started", "rolled_back", "committed", "unknown"].includes(String(sourceExecution?.write_outcome))
      ? sourceExecution.write_outcome
      : "not_started",
    retry: ["safe_now", "after_change", "reconcile_first", "never"].includes(String(sourceExecution?.retry))
      ? sourceExecution.retry
      : sourceRetryable === true ? "safe_now" : "after_change",
  };
  const target = operation === "automatic_process_lessons"
    ? "solarisael-house-proof/triggers.ts:processLessonsReminder"
    : "solarisael-house-proof/recall.ts:recallWithRouting";

  return {
    ...inherited,
    code: String(source?.code || sourceDetails?.code || `AUTO_CONTEXT_${operation.toUpperCase()}_FAILED`),
    category: sourceDetails?.category || "operation",
    stage: sourceDetails?.stage || stage,
    operation,
    owner: { component: "omp-adapter", path: "index.ts", symbol: "solarisaelHouseProof context hook" },
    expected: {
      hidden_context: true,
      display: false,
      outcome: "injected_or_fail_open",
    },
    observed: {
      outcome: "failed_open",
      route_intent: route?.intent || null,
      route_should_auto_recall: route?.shouldAutoRecall === true,
    },
    evidence: [...inheritedEvidence, { kind: "automatic_context_failure", cause: childCause }],
    targets: ["index.ts:solarisaelHouseProof", target],
    next_checks: [
      { action: "inspect", target },
      { action: "retry", condition: execution.retry },
    ],
    execution,
  };
}

async function recordAutomaticContextTelemetry(
  input: Parameters<typeof recordRecallTelemetry>[0] & { diagnostic?: Record<string, unknown> },
): Promise<boolean> {
  const { diagnostic, ...telemetry } = input;
  return recordRecallTelemetry({
    ...telemetry,
    viewportDiagnostics: diagnostic || telemetry.viewportDiagnostics,
  });
}

export default function solarisaelHouseProof(pi) {
  pi.setLabel("Solarisael House");

  pi.on("context", async (event, ctx) => {
    const messages = Array.isArray(event?.messages) ? event.messages : [];
    const promptMessage = [...messages].reverse().find((message) => message?.role === "user");
    const prompt = messageText(promptMessage);
    if (!prompt.trim()) return;

    const existingTypes = new Set(
      messages
        .filter((message) => message?.role === "custom" && typeof message?.customType === "string")
        .map((message) => message.customType),
    );

    const { room, spirit, operator, effectiveRoomDir, sharedRoot } = roomContext(ctx.cwd);
    const timestamp = Date.now();
    const additions = [];
    let houseState = null;

    try {
      const stateResult = await applyPromptDirectives(ctx, prompt);
      houseState = stateResult.state;
      await writeActiveSpiritSnapshot(effectiveRoomDir, houseState);
    } catch {
      // Room-state/active-spirit maintenance must never block context injection.
    }

    const modelDefault = houseState?.modelDefault;
    const modelKey = `${room}:${ctx.cwd || effectiveRoomDir}:${modelDefault?.model || ""}`;
    if (modelDefault?.enabled && modelDefault.model && !modelDefaultsApplied.has(modelKey) && typeof pi.setModel === "function") {
      try {
        const resolved = ctx.models?.resolve?.(modelDefault.model);
        if (resolved) {
          await pi.setModel(modelDefault.model);
          modelDefaultsApplied.add(modelKey);
        }
      } catch {
        // Room model defaults are convenience only; bad model specs must not block context.
      }
    }

    if (process.env.SOLARISAEL_REPLAY_MODE !== "1") {
      try {
        await logUnseenConversationTurns(ctx, messages, "context");
      } catch {
        // Live context and ledger writes are useful, but must never block context injection.
      }
    }

    if (!existingTypes.has("solarisael-room-context")) {
      additions.push({
        role: "custom",
        customType: "solarisael-room-context",
        content: [
          "<system-reminder>",
          `Room: ${room}`,
          `Active spirit: ${houseState?.embodiedSpirit || spirit}`,
          `Operator: ${houseState?.operator || operator}`,
          "Durable-memory discipline: preserve the concrete facts needed for future recognition: names, observable details, actions, boundaries, and meaning.",
          "A memory must stand alone. A transcript is provenance, not the only substance.",
          "In Full House, PostgreSQL is authoritative for durable memories and lessons. A source path is provenance or backup, never a substitute for the database body.",
          "Do not claim a memory was written without a successful remember receipt.",
          "This is hidden LLM context only: it must not be persisted or rendered.",
          "</system-reminder>",
        ].join("\n"),
        display: false,
        attribution: "agent",
        timestamp,
      });
    }

    if (houseState?.routingMode?.enabled && !existingTypes.has("solarisael-routing-mode")) {
      additions.push({
        role: "custom",
        customType: "solarisael-routing-mode",
        content: [
          "<system-reminder>",
          "Solarisael House worker-routing mode is enabled.",
          "Default modus operandi for delegable work:",
          "1. Main model owns intent, inference, and final judgment.",
          "2. Use house_lane_status/house_dispatch before spawning task/subagents when work is bounded and delegable.",
          "3. Do not route casual contact, high-level judgment, or exact-sensitive work without exact/retrieve-only context.",
          "4. Advisor is a separate review channel, not a dispatch lane.",
          "</system-reminder>",
        ].join("\n"),
        display: false,
        details: { enabled: true },
        attribution: "agent",
        timestamp,
      });
    }
    const wakeKey = `${room}:${ctx.sessionID || ctx.cwd || effectiveRoomDir}`;
    const freshWake = isFreshConversation(messages) && !wokenSessions.has(wakeKey);
    if (freshWake) wokenSessions.add(wakeKey);
    if (freshWake && !existingTypes.has("solarisael-wake-context")) {
      try {
        const boat = await catchBoat(sharedRoot, room);
        if (boat?.ok && boat?.found) {
          const content = formatWakeContext(boat);
          if (content) {
            additions.push({
              role: "custom",
              customType: "solarisael-wake-context",
              content,
              display: false,
              details: { title: boat.title || null, source_path: boat.source_path || null },
              attribution: "agent",
              timestamp,
            });
          }
        }
      } catch {
        // Auto-wake is fail-open. Manual wake remains available.
      }
    }
    if (freshWake && !existingTypes.has("solarisael-anamnesis-wake")) {
      try {
        const result = await queryAnamnesis(effectiveRoomDir, room, { mode: "wake" });
        if (result?.ok) {
          const content = formatAnamnesisContext(result, { automatic: true });
          if (content) {
            additions.push({
              role: "custom",
              customType: "solarisael-anamnesis-wake",
              content,
              display: false,
              details: { mode: "wake", warnings: result.warnings || [] },
              attribution: "agent",
              timestamp,
            });
          }
        }
      } catch {
        // Cabinet wake is advisory and fail-open. Manual anamnesis remains available.
      }
    }

    const keyword = await keywordReminder(prompt);
    if (keyword && !existingTypes.has("solarisael-keyword-directive")) {
      additions.push({
        role: "custom",
        customType: "solarisael-keyword-directive",
        content: keyword.text,
        display: false,
        details: { keywords: keyword.keywords },
        attribution: "agent",
        timestamp,
      });
    }

    if (!existingTypes.has("solarisael-process-lessons")) {
      try {
        const processLessons = await processLessonsReminder(prompt, effectiveRoomDir, room);
        if (processLessons) {
          additions.push({
            role: "custom",
            customType: "solarisael-process-lessons",
            content: processLessons.text,
            display: false,
            details: { trigger: processLessons.trigger, lessons: processLessons.lessons },
            attribution: "agent",
            timestamp,
          });
        }
      } catch (error) {
        await recordAutomaticContextTelemetry({
          effectiveRoomDir,
          sessionId: ctx?.sessionID || ctx?.sessionId,
          room,
          prompt,
          route: null,
          status: "error",
          error: redactDiagnosticText(error),
          diagnostic: automaticContextDiagnostic({
            operation: "automatic_process_lessons",
            stage: "request_parse",
            error,
            requestDispatched: true,
          }),
        }).catch(() => undefined);
        // Process-shape lessons are advisory only. Tooling must fail open.
      }
    }

    if (!existingTypes.has("solarisael-recall-context") && process.env.SOLARISAEL_DISABLE_AUTO_RECALL !== "1") {
      let queryRoute = null;
      try {
        const { classifyRetrievalQuery } = await loadHouseQueryRouting();
        const preliminaryRoute = classifyRetrievalQuery(prompt);
        const resolution = preliminaryRoute.entityResolutionSuggested
          ? await resolveEntities({ room, roomDir: effectiveRoomDir, query: prompt })
          : { ok: true, matches: [] };
        queryRoute = classifyRetrievalQuery(prompt, {
          recognizedEntities: resolution.matches.map((match) => match.canonicalName),
        });
        if (queryRoute.shouldAutoRecall) {
          const recalled = await recallWithRouting(effectiveRoomDir, room, queryRoute.recallQuery || prompt);
          if (recalled.ok) {
            const compact = compactRecall(recalled.result);
            const viewportKey = `${ctx?.sessionID || ctx?.sessionId || "session"}:${room}`;
            let viewportSession = recallViewportSessions.get(viewportKey);
            if (!viewportSession) {
              viewportSession = createRecallViewportSession();
              recallViewportSessions.set(viewportKey, viewportSession);
              if (recallViewportSessions.size >= 64) {
                recallViewportSessions.delete(recallViewportSessions.keys().next().value);
              }
            }
            const viewport = automaticRecallViewport(compact, { session: viewportSession });
            const filteredCanonMatches = viewport.keptCandidates.length ? compact.canonMatches : [];
            const automaticCompact = {
              ...compact,
              retrievalCandidates: viewport.keptCandidates,
              canonMatches: filteredCanonMatches,
              semanticChunks: [],
              contentChunks: [],
              found: Boolean(
                viewport.keptCandidates.length
                || filteredCanonMatches.length
                || compact.dateMatches?.length
              ),
            };
            if (automaticCompact.found) {
              additions.push({
                role: "custom",
                customType: "solarisael-recall-context",
                content: [
                  "<system-reminder>",
                  "Room-local Solarisael recall for this user turn.",
                  JSON.stringify(automaticCompact, null, 2),
                  "</system-reminder>",
                ].join("\n"),
                display: false,
                details: { query: automaticCompact.query, found: automaticCompact.found, queryRoute, viewport: viewport.diagnostics },
                attribution: "agent",
                timestamp,
              });
            }
            await recordRecallTelemetry({
              effectiveRoomDir,
              sessionId: ctx?.sessionID || ctx?.sessionId,
              room,
              prompt,
              route: queryRoute,
              status: automaticCompact.found ? "injected" : "empty",
              viewport: automaticCompact,
              viewportDiagnostics: viewport.diagnostics,
            });
          } else {
            await recordAutomaticContextTelemetry({
              effectiveRoomDir,
              sessionId: ctx?.sessionID || ctx?.sessionId,
              room,
              prompt,
              route: queryRoute,
              status: "error",
              error: redactDiagnosticText(recalled.result?.error || "recall failed", [queryRoute?.recallQuery, prompt]),
              diagnostic: automaticContextDiagnostic({
                operation: "automatic_recall",
                stage: "request_parse",
                error: recalled.result?.error || "recall failed",
                failure: recalled.result,
                route: queryRoute,
                requestDispatched: true,
              }),
            }).catch(() => undefined);
          }
        } else {
          await recordRecallTelemetry({
            effectiveRoomDir,
            sessionId: ctx?.sessionID || ctx?.sessionId,
            room,
            prompt,
            route: queryRoute,
            status: "skipped",
          });
        }
      } catch (error) {
        await recordAutomaticContextTelemetry({
          effectiveRoomDir,
          sessionId: ctx?.sessionID || ctx?.sessionId,
          room,
          prompt,
          route: queryRoute,
          status: "error",
          error: redactDiagnosticText(error, [queryRoute?.recallQuery, prompt]),
          diagnostic: automaticContextDiagnostic({
            operation: "automatic_recall",
            stage: queryRoute ? "request_parse" : "configuration_load",
            error,
            route: queryRoute,
            requestDispatched: Boolean(queryRoute?.shouldAutoRecall),
          }),
        }).catch(() => undefined);
        // Context injection must fail open. Manual recall remains available.
      }
    }

    const nudge = await contextNudge(messages, room);
    if (nudge && !existingTypes.has("solarisael-context-nudge")) {
      additions.push({
        role: "custom",
        customType: "solarisael-context-nudge",
        content: ["<system-reminder>", nudge.text, "</system-reminder>"].join("\n"),
        display: false,
        details: { pct: nudge.pct, tokens: nudge.tokens },
        attribution: "agent",
        timestamp,
      });
    }

    if (!additions.length) return;
    return { messages: [...messages, ...additions] };
  });

  pi.on("shutdown", () => {
    closeRustRecallTransports();
    closeRustRememberTransports();
    closeRustAnamnesisTransports();
  });

  pi.on("agent_end", async (event, ctx) => {
    if (process.env.SOLARISAEL_REPLAY_MODE === "1") return;
    try {
      await logUnseenConversationTurns(ctx, event?.messages || [], "agent_end");
    } catch {
      // Logging must never perturb the visible OMP turn.
    }
  });

  registerSolarisaelTools(pi);
}
