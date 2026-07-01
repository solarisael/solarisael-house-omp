// OMP trigger adapter.
// Silhouette: normalize OMP messages, preserve OMP-local band state, call the shared pure core.

import {
  computeContextNudge,
  detectKeywordTriggers,
  formatProcessLessonsBanner,
  matchProcessShape,
} from "file:///C:/Projects/solarisael-house/src/index.ts";
import { conversationTurns } from "./conversation-log.ts";
import { runCodingLessons } from "./substrate.ts";
import { messageText } from "./text.ts";

const nudgeBandByRoom = new Map();

function compactPayload(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function pushPayload(target, value) {
  const text = compactPayload(value).trim();
  if (text) target.push(text);
}

function pushPayloads(target, value) {
  if (Array.isArray(value)) {
    for (const item of value) pushPayload(target, item);
    return;
  }
  pushPayload(target, value);
}

function toolPartPayload(part) {
  if (!part || typeof part !== "object") return part;
  const name = part.name || part.toolName || part.tool || part.id || part.toolCallId || part.tool_call_id || part.tool_use_id;
  const args = part.args ?? part.arguments ?? part.input ?? part.parameters ?? part.result ?? part.output ?? part.content;
  if (name || args !== undefined) return { name, args };
  return part;
}

function collectToolTraffic(message) {
  const toolCalls = [];
  const toolResults = [];

  pushPayloads(toolCalls, message?.toolCalls || message?.tool_calls || message?.calls);
  pushPayloads(toolResults, message?.toolResults || message?.tool_results || message?.results);

  const parts = [
    ...(Array.isArray(message?.content) ? message.content : []),
    ...(Array.isArray(message?.parts) ? message.parts : []),
  ];

  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const type = String(part.type || part.kind || "").toLowerCase();
    const hasToolId = Boolean(part.toolCallId || part.tool_call_id || part.tool_use_id);
    const looksLikeCall = type.includes("tool") && (type.includes("call") || type.includes("use"));
    const looksLikeResult = type.includes("tool") && (type.includes("result") || type.includes("output"));
    if (looksLikeCall || part.toolCall || part.tool_call) pushPayload(toolCalls, toolPartPayload(part));
    else if (looksLikeResult || (hasToolId && (part.result !== undefined || part.output !== undefined))) pushPayload(toolResults, toolPartPayload(part));
  }

  return { toolCalls, toolResults };
}

function normalizeOmpMessages(messages) {
  const turnsByIndex = new Map(conversationTurns(messages).map((turn) => [turn.index, turn]));
  return (Array.isArray(messages) ? messages : []).map((message, index) => {
    const turn = turnsByIndex.get(index);
    const { toolCalls, toolResults } = collectToolTraffic(message);
    const injection = (message?.role === "custom" || message?.role === "system") ? messageText(message).trim() : "";
    return {
      role: message?.role || "unknown",
      textParts: turn?.text ? [turn.text] : [],
      toolCalls,
      toolResults,
      injections: injection ? [injection] : [],
    };
  });
}

export function contextNudge(messages, room) {
  const key = String(room || "room").toLowerCase();
  const lastBand = nudgeBandByRoom.get(key) || 0;
  const nudge = computeContextNudge({ messages: normalizeOmpMessages(messages), room, lastBand });
  if (!nudge) return null;
  nudgeBandByRoom.set(key, nudge.band);
  return { pct: nudge.pct, tokens: nudge.tokens, text: nudge.text };
}

export function keywordReminder(prompt) {
  const fired = detectKeywordTriggers(String(prompt || ""));
  if (!fired.length) return null;
  return {
    keywords: fired.map((f) => f.keyword),
    text: [
      "## Solarisael Keyword Directive",
      fired.map((f) => f.directive).join("\n\n"),
    ].join("\n"),
  };
}

export async function processLessonsReminder(prompt, effectiveRoomDir, room) {
  const triggerName = matchProcessShape(String(prompt || ""));
  if (!triggerName) return null;
  const result = await runCodingLessons(effectiveRoomDir, room, "process");
  if (!result.ok || !Array.isArray(result.lessons) || result.lessons.length === 0) return null;
  const banner = formatProcessLessonsBanner(result.lessons, triggerName);
  if (!banner) return null;
  return {
    trigger: triggerName,
    lessons: result.lessons.length,
    text: [
      "<system-reminder>",
      "Solarisael process-shape lessons matched this user turn.",
      "Use this as hidden reasoning context before advising on the matched process. Do not render this banner verbatim unless Sol asks.",
      "",
      banner,
      "</system-reminder>",
    ].join("\n"),
  };
}
