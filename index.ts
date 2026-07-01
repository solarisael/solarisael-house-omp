// Solarisael House — OMP adapter entrypoint.
//
// This file stays where OMP config expects it. The implementation is split into
// shaped modules under ./solarisael-house-proof/ so this door only wires hooks.

import { isFreshConversation, logUnseenConversationTurns } from "./solarisael-house-proof/conversation-log.ts";
import { compactRecall, recallWithFallback } from "./solarisael-house-proof/recall.ts";
import {
  applyPromptDirectives,
  roomContext,
  writeActiveSpiritSnapshot,
} from "./solarisael-house-proof/room.ts";
import { catchBoat, formatWakeContext } from "./solarisael-house-proof/substrate.ts";
import { messageText } from "./solarisael-house-proof/text.ts";
import { registerSolarisaelTools } from "./solarisael-house-proof/tools.ts";
import { contextNudge, keywordReminder, processLessonsReminder } from "./solarisael-house-proof/triggers.ts";

const wokenSessions = new Set();

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

    try {
      await logUnseenConversationTurns(ctx, messages, "context");
    } catch {
      // Live context and ledger writes are useful, but must never block context injection.
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
          "This is hidden LLM context only: it must not be persisted or rendered.",
          "</system-reminder>",
        ].join("\n"),
        display: false,
        attribution: "agent",
        timestamp,
      });
    }

    const wakeKey = `${room}:${ctx.cwd || effectiveRoomDir}`;
    if (isFreshConversation(messages) && !wokenSessions.has(wakeKey) && !existingTypes.has("solarisael-wake-context")) {
      wokenSessions.add(wakeKey);
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

    if (!existingTypes.has("solarisael-recall-context")) {
      try {
        const recalled = await recallWithFallback(effectiveRoomDir, room, prompt);
        if (recalled.ok) {
          const compact = compactRecall(recalled.result);
          if (compact.found) {
            additions.push({
              role: "custom",
              customType: "solarisael-recall-context",
              content: [
                "<system-reminder>",
                "Room-local Solarisael recall for this user turn.",
                JSON.stringify(compact, null, 2),
                "</system-reminder>",
              ].join("\n"),
              display: false,
              details: { query: compact.query, found: compact.found },
              attribution: "agent",
              timestamp,
            });
          }
        }
      } catch {
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
    try {
      await logUnseenConversationTurns(ctx, event?.messages || [], "agent_end");
    } catch {
      // Logging must never perturb the visible OMP turn.
    }
  });

  registerSolarisaelTools(pi);
}
