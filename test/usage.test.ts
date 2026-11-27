import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { specTempDir } from "../scripts/testkit";
import { cleanUsage, collectUsage, formatUsage } from "../src/usage";
import { STANDARD_TOTAL, assistant, c, standardSession, user, writeTranscript } from "./transcript-fixture";

const root = specTempDir("cnoc-usage-");
let n = 0;
/** A fresh config dir and session id per test. */
const fresh = () => ({ config: join(root, `cfg-${++n}`), session: `sess-${n}` });
const env = (config: string, session: string) => ({ CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_SESSION_ID: session });

test("finds the transcript by session id and counts each response once, subagents included", async () => {
  const { config, session } = fresh();
  standardSession(config, session);
  const u = await collectUsage(env(config, session));
  expect(u).toMatchObject({ harness: "claude", session, tokens: STANDARD_TOTAL, responses: 3 });
  expect(u?.partial).toBeUndefined();
  expect(u?.by_model).toEqual({
    "claude-opus-test": { input: 15, output: 50, cache_creation: 100, cache_read: 100 },
    "claude-sonnet-test": { input: 1, output: 7, cache_creation: 3, cache_read: 4 },
  });
});

test("a response repeated across lines and files counts once, with its largest output", async () => {
  const { config, session } = fresh();
  writeTranscript(
    config,
    session,
    [
      // The final block can be written before an earlier, smaller one.
      assistant("msg_a", "m", c(3, 40, 0, 9), "tool_use"),
      assistant("msg_a", "m", c(3, 5, 0, 9), null),
      assistant("msg_a", "m", c(3, 40, 0, 9), "tool_use"),
    ],
    {
      "agent-x.jsonl": [assistant("msg_b", "m", c(1, 1)), assistant("msg_b", "m", c(1, 1))],
      // A second subagent file that repeats a response the first holds, nested as workflows are.
      "workflows/wf-1/agent-y.jsonl": [assistant("msg_b", "m", c(1, 1)), assistant("msg_c", "m", c(2, 2))],
    },
  );
  const u = await collectUsage(env(config, session));
  expect(u?.tokens).toEqual({ input: 6, output: 43, cache_creation: 0, cache_read: 9 });
  expect(u?.responses).toBe(3);
});

test("zero-usage placeholder entries and non-assistant lines are not counted", async () => {
  const { config, session } = fresh();
  writeTranscript(config, session, [
    assistant("msg_err", "<synthetic>", c(0, 0)),
    JSON.stringify({ type: "user", message: { usage: { input_tokens: 999 } } }),
    user("hello"),
    assistant("msg_ok", "m", c(1, 2)),
  ]);
  const u = await collectUsage(env(config, session));
  expect(u?.by_model).toEqual({ m: { input: 1, output: 2, cache_creation: 0, cache_read: 0 } });
});

test("a malformed line is skipped, and one that carried usage marks the total partial", async () => {
  const { config, session } = fresh();
  writeTranscript(config, session, [
    "{not json",
    assistant("msg_1", "m", c(1, 1)),
    '{"type":"assistant","message":{"usage":{"input_tokens":5', // cut off mid-write
    "",
    "[]",
    "null",
    assistant("msg_2", "m", c(2, 2)),
  ]);
  const u = await collectUsage(env(config, session));
  expect(u?.tokens).toEqual({ input: 3, output: 3, cache_creation: 0, cache_read: 0 });
  expect(u?.partial).toBe("1 line with usage could not be parsed");
});

test("no session variable, an unknown session or a missing config dir gives no usage", async () => {
  const { config, session } = fresh();
  standardSession(config, session);
  expect(await collectUsage({ CLAUDE_CONFIG_DIR: config })).toBeNull();
  expect(await collectUsage(env(config, "no-such-session"))).toBeNull();
  expect(await collectUsage(env(join(root, "nowhere"), session))).toBeNull();
  expect(await collectUsage(env(config, "../escape"))).toBeNull();
});

test("the config dir defaults to ~/.claude", async () => {
  const { config, session } = fresh();
  standardSession(join(config, ".claude"), session);
  const u = await collectUsage({ HOME: config, CLAUDE_CODE_SESSION_ID: session });
  expect(u?.tokens).toEqual(STANDARD_TOTAL);
});

test("a hook's transcript path and session id win over the environment", async () => {
  const { config, session } = fresh();
  const file = standardSession(join(config, "elsewhere"), session);
  const u = await collectUsage(env(join(root, "nowhere"), "other"), { session_id: session, transcript_path: file });
  expect(u?.session).toBe(session);
  expect(u?.tokens).toEqual(STANDARD_TOTAL);
});

test("a read that runs out of time returns what it has, marked partial", async () => {
  const { config, session } = fresh();
  standardSession(config, session);
  const u = await collectUsage(env(config, session), null, -1);
  expect(u?.partial).toBe("read stopped at its time limit");
  expect(u?.responses).toBe(0);
});

test("a large transcript is read as a stream, line by line", async () => {
  const { config, session } = fresh();
  const file = writeTranscript(config, session, []);
  const filler = user("x".repeat(1024 * 1024));
  const lines: string[] = [];
  for (let i = 0; i < 40; i++) lines.push(filler, assistant(`msg_${i}`, "m", c(1, 1)));
  writeFileSync(file, `${lines.join("\n")}\n`);
  const u = await collectUsage(env(config, session));
  expect(u?.responses).toBe(40);
  expect(u?.tokens.input).toBe(40);
});

test("usage from the socket is checked field by field", () => {
  const good = {
    harness: "claude",
    session: "s",
    tokens: { input: 1, output: 2, cache_creation: 3, cache_read: 4 },
    by_model: { m: { input: 1, output: 2, cache_creation: 3, cache_read: 4 }, bad: { input: -1 } },
    responses: 1,
    at: 5,
  };
  expect(cleanUsage(good)).toEqual({ ...good, by_model: { m: good.by_model.m } });
  expect(cleanUsage({ ...good, tokens: { input: "1" } })).toBeUndefined();
  expect(cleanUsage(null)).toBeUndefined();
  expect(cleanUsage("claude")).toBeUndefined();
  expect(formatUsage({ ...good, by_model: { m: good.by_model.m } })).toBe(
    "claude 1 in, 2 out, 3 cache write, 4 cache read (m)",
  );
});
