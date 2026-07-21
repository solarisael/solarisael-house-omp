import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("a reloaded adapter does not duplicate transcript or live-context turns", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "omp-conversation-dedupe-"));
  const cwd = path.join(root, "example");
  await mkdir(cwd, { recursive: true });
  await writeFile(path.join(cwd, ".solarisael-room.json"), `${JSON.stringify({
    version: 1,
    room: "example",
    trueName: "Example Room",
    operator: "Example Operator",
  })}\n`, "utf8");
  await writeFile(path.join(root, "shared_current_state.md"), "# Shared state\n", "utf8");

  try {
    const first = await import("../solarisael-house-proof/conversation-log.ts?dedupe-instance=1");
    const second = await import("../solarisael-house-proof/conversation-log.ts?dedupe-instance=2");
    const messages = [{ role: "user", id: "stable-turn", content: "One durable turn." }];
    const ctx = { cwd, sessionID: "dedupe-session" };

    await first.logUnseenConversationTurns(ctx, messages, "first-instance");
    await second.logUnseenConversationTurns(ctx, messages, "second-instance");

    const live = JSON.parse(await readFile(path.join(cwd, "current_session_context.json"), "utf8"));
    expect(live.recentTurns).toHaveLength(1);
    expect(live.recentTurns[0]).toMatchObject({ role: "user", text: "One durable turn." });

    const transcriptName = (await readdir(cwd)).find((name) => /^conversation_log_.*\.md$/.test(name));
    expect(transcriptName).toBeDefined();
    const transcript = await readFile(path.join(cwd, transcriptName!), "utf8");
    expect(transcript.match(/One durable turn\./g)).toHaveLength(1);
    expect(transcript).toMatch(/## \d{2}:\d{2} — Example Operator/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
