export const ADAPTER_API_VERSION = 1;

// Solarisael House — OMP adapter entrypoint.
//
// This file stays where OMP config expects it. The implementation is split into
// shaped modules under ./solarisael-house-proof/ so this door only wires hooks.

import { isFreshConversation, logUnseenConversationTurns } from "./solarisael-house-proof/conversation-log.ts";
import { compactRecall, recallWithFallback } from "./solarisael-house-proof/recall.ts";
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

    const { room, spirit, effectiveRoomDir, sharedRoot } = roomContext(ctx.cwd);
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
          `Operator: ${houseState?.operator || "Sol"}`,
          "Durable-memory discipline: preserve the concrete facts needed for future recognition: names, observable details, actions, boundaries, and meaning.",
          "A memory must stand alone. A transcript is provenance, not the only substance.",
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

    const keyword = keywordReminder(prompt);
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
      } catch {
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
          const recalled = await recallWithFallback(effectiveRoomDir, room, queryRoute.recallQuery || prompt);
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
            await recordRecallTelemetry({
              effectiveRoomDir,
              sessionId: ctx?.sessionID || ctx?.sessionId,
              room,
              prompt,
              route: queryRoute,
              status: "error",
              error: recalled.error || "recall failed",
            });
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
        await recordRecallTelemetry({
          effectiveRoomDir,
          sessionId: ctx?.sessionID || ctx?.sessionId,
          room,
          prompt,
          route: queryRoute,
          status: "error",
          error,
        }).catch(() => undefined);
        // Context injection must fail open. Manual recall remains available.
      }
    }

    const nudge = contextNudge(messages, room);
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
