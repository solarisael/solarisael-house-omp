// Conversation capture for the OMP adapter.
// Silhouette: take visible user/assistant turns and write the room ledger + markdown log.

import path from "node:path";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { OMP_SESSION_ID, TRANSCRIPT_DEBUG_LOG } from "./constants.ts";
import { loadHouseLedger } from "./core.ts";
import { roomContext } from "./room.ts";
import { conversationText, localDateStamp, smallHash } from "./text.ts";

export function conversationTurns(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map((message, index) => {
      const role = message?.role;
      if (role !== "user" && role !== "assistant") return null;
      const text = conversationText(message).trim();
      if (!text) return null;
      const rawID = message?.id || message?.messageID || message?.info?.id || message?.timestamp;
      const messageID = rawID || index;
      return { role, text, index, messageID, hasStableID: Boolean(rawID) };
    })
    .filter(Boolean);
}

export function isFreshConversation(messages) {
  return conversationTurns(messages).length <= 1;
}

function conversationTurnKey(ctx, turn) {
  const session = ctx?.sessionID || ctx?.sessionId || OMP_SESSION_ID;
  const identity = turn.hasStableID ? `id:${turn.messageID}` : `text:${smallHash(turn.text)}`;
  return `${session}:${turn.role}:${identity}:${smallHash(turn.text)}`;
}

async function writeTranscriptDebug(ctx, entry) {
  const { effectiveRoomDir, room } = roomContext(ctx?.cwd || process.cwd());
  const target = path.join(effectiveRoomDir, "logs", TRANSCRIPT_DEBUG_LOG);
  await mkdir(path.dirname(target), { recursive: true });
  await appendFile(target, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    room,
    source: "omp",
    ...entry,
  })}\n`, "utf8");
}

async function appendRoomTranscriptTurn(ctx, turn) {
  const { effectiveRoomDir, spirit } = roomContext(ctx?.cwd || process.cwd());
  const stamp = localDateStamp();
  const target = path.join(effectiveRoomDir, `conversation_log_${stamp}.md`);
  const key = conversationTurnKey(ctx, turn);
  const marker = `<!-- solarisael-turn-key: ${key} -->`;
  let existing = "";
  try {
    existing = await readFile(target, "utf8");
  } catch {
    existing = "";
  }
  if (existing.includes(marker)) return { target, key, appended: false, reason: "already-present" };

  const header = existing.trim()
    ? ""
    : [
        `# Conversation log — ${stamp}`,
        "",
        "Append-only raw-ish transcript captured by the OMP Solarisael House extension.",
        "",
        "---",
        "",
      ].join("\n");
  const separator = existing && !existing.endsWith("\n\n") ? "\n\n" : "";
  const label = turn.role === "user" ? "Sol" : spirit;
  const clock = new Date().toISOString().slice(11, 16);
  await appendFile(
    target,
    `${separator}${header}${marker}\n## ${clock} — ${label}\n\n${turn.text}\n\n`,
    "utf8",
  );
  return { target, key, appended: true };
}

async function logRoomTurn(ctx, role, text) {
  const { room, spirit, effectiveRoomDir, sharedRoot } = roomContext(ctx?.cwd || process.cwd());
  const ledger = await loadHouseLedger();
  const meta = {
    sessionID: OMP_SESSION_ID,
    messageID: `${role}-${Date.now()}`,
    agentName: spirit,
    spirit,
    operator: "Sol",
  };
  const paths = { roomDir: effectiveRoomDir, sharedRoot };
  if (role === "user") return ledger.logUserTurn(meta, text, paths);
  return ledger.logAssistantTurn(meta, text, paths);
}

const loggedTurnKeys = new Set();

export async function logUnseenConversationTurns(ctx, messages, source = "unknown") {
  const turns = conversationTurns(messages);
  let appended = 0;
  let skipped = 0;
  const errors = [];
  for (const turn of turns) {
    const key = conversationTurnKey(ctx, turn);
    if (loggedTurnKeys.has(key)) {
      skipped += 1;
      continue;
    }

    let wroteAnything = false;
    try {
      await logRoomTurn(ctx, turn.role, turn.text);
      wroteAnything = true;
    } catch (err) {
      errors.push({ key, surface: "ledger", error: err?.message || String(err) });
    }

    try {
      const result = await appendRoomTranscriptTurn(ctx, turn);
      if (result.appended) appended += 1;
      else skipped += 1;
      wroteAnything = true;
    } catch (err) {
      errors.push({ key, surface: "transcript", error: err?.message || String(err) });
    }

    if (wroteAnything) loggedTurnKeys.add(key);
  }

  try {
    await writeTranscriptDebug(ctx, {
      source,
      turns: turns.length,
      appended,
      skipped,
      errors,
    });
  } catch {
    // Debug logging must never block transcript capture.
  }
}
