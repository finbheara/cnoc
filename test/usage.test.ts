import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { specTempDir } from "../scripts/testkit";
import type { Usage } from "../src/protocol";
import { type Collector, MAX_MODELS, betterUsage, cleanUsage, collectUsage, formatUsage, lines } from "../src/usage";
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

/** A byte stream that hands out one chunk per pull and counts the pulls. */
function chunked(chunks: string[]) {
  const enc = new TextEncoder();
  const pulled = { n: 0 };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(ctl) {
        const next = chunks[pulled.n++];
        if (next === undefined) ctl.close();
        else ctl.enqueue(enc.encode(next));
      },
    },
    // Pull only when read, so the count says how far the reader got.
    { highWaterMark: 0 },
  );
  return { stream, pulled };
}

test("lines are yielded as their chunks arrive, before the rest of the file is read", async () => {
  const { stream, pulled } = chunked(["one\ntw", "o\nthr", "ee\n", "four"]);
  const it = lines(stream, Number.POSITIVE_INFINITY);
  expect((await it.next()).value).toBe("one");
  expect(pulled.n).toBe(1);
  const rest: string[] = [];
  for await (const l of { [Symbol.asyncIterator]: () => it }) rest.push(l);
  expect(rest).toEqual(["two", "three", "four"]);
});

test("a line longer than the limit is skipped and the next one is read", async () => {
  const { stream } = chunked(["short\n", "x".repeat(30), "y".repeat(30), "\nafter\n"]);
  const out: string[] = [];
  for await (const l of lines(stream, Number.POSITIVE_INFINITY, 40)) out.push(l);
  expect(out).toEqual(["short", "after"]);
});

test("a read stops at its deadline partway through, keeping what it read", async () => {
  const { stream, pulled } = chunked(["a\n", "b\n", "c\n", "d\n"]);
  let clock = 0;
  const it = lines(stream, 2, undefined, () => ++clock);
  const out: string[] = [];
  let r = await it.next();
  for (; !r.done; r = await it.next()) out.push(r.value);
  expect(out).toEqual(["a", "b"]);
  expect(r.value).toBe("timeout");
  expect(pulled.n).toBe(2);
});

test("a read that runs out of time returns what it has, marked partial", async () => {
  const { config, session } = fresh();
  standardSession(config, session);
  const u = await collectUsage(env(config, session), null, -1);
  expect(u?.partial).toBe("read stopped at its time limit");
  expect(u?.responses).toBe(0);
});

test("a collector stuck in a call that never returns is given up as no usage", async () => {
  const stuck: Collector = {
    sessionVars: [],
    locate: async () => ({ session: "s", files: [] }),
    read: () => new Promise(() => {}),
  };
  expect(await collectUsage({}, null, 0, { stuck })).toBeNull();
});

test("an unreadable main transcript gives no usage, not zeros", async () => {
  const { config, session } = fresh();
  const file = standardSession(config, session);
  chmodSync(file, 0o000);
  // Root reads anything; the check means nothing there.
  if (process.getuid?.() !== 0) expect(await collectUsage(env(config, session))).toBeNull();
  chmodSync(file, 0o600);

  const dir = fresh();
  mkdirSync(join(dir.config, "projects", "-work-myapp", `${dir.session}.jsonl`), { recursive: true });
  expect(await collectUsage(env(dir.config, dir.session))).toBeNull();
});

test("subagent folders are not followed through symbolic links", async () => {
  const { config, session } = fresh();
  const file = standardSession(config, session);
  const elsewhere = join(root, `elsewhere-${n}`);
  writeTranscript(elsewhere, "x", [], { "agent-z.jsonl": [assistant("msg_z", "m", c(100, 100))] });
  symlinkSync(
    join(elsewhere, "projects", "-work-myapp", "x", "subagents"),
    join(file.replace(/\.jsonl$/, ""), "subagents", "linked"),
  );
  expect((await collectUsage(env(config, session)))?.tokens).toEqual(STANDARD_TOTAL);
});

test("a model named __proto__ is only a name", async () => {
  const { config, session } = fresh();
  writeTranscript(config, session, [assistant("msg_p", "__proto__", c(1, 1))]);
  const u = await collectUsage(env(config, session));
  expect(Object.keys(u?.by_model ?? {})).toEqual(["__proto__"]);
  expect(({} as Record<string, unknown>).input).toBeUndefined();
  const clean = cleanUsage(JSON.parse(JSON.stringify(u)));
  expect(Object.keys(clean?.by_model ?? {})).toEqual(["__proto__"]);
  expect(({} as Record<string, unknown>).input).toBeUndefined();
});

test("more models than the cap are counted together", async () => {
  const { config, session } = fresh();
  const many = Array.from({ length: MAX_MODELS + 5 }, (_, i) => assistant(`msg_${i}`, `model-${i}`, c(1, 0)));
  writeTranscript(config, session, many);
  const u = await collectUsage(env(config, session));
  expect(Object.keys(u?.by_model ?? {})).toHaveLength(MAX_MODELS);
  expect(u?.by_model["(other)"]?.input).toBe(6);
  expect(u?.tokens.input).toBe(MAX_MODELS + 5);
});

test("usage from the socket is checked field by field", () => {
  const m = { input: 1, output: 2, cache_creation: 3, cache_read: 4 };
  const good = {
    harness: "claude",
    session: "s",
    tokens: m,
    by_model: { m, bad: { input: -1 }, frac: { ...m, input: 1.5 }, [`${"x".repeat(201)}`]: m },
    responses: 1,
    at: 5,
  };
  expect(cleanUsage(good)).toEqual({ ...good, by_model: { m } });
  expect(cleanUsage({ ...good, tokens: { ...m, input: "1" } })).toBeUndefined();
  expect(cleanUsage({ ...good, tokens: { ...m, output: Number.POSITIVE_INFINITY } })).toBeUndefined();
  expect(cleanUsage({ ...good, responses: -1 })).toBeUndefined();
  expect(cleanUsage({ ...good, at: undefined })).toBeUndefined();
  expect(cleanUsage({ ...good, session: "s".repeat(201) })).toBeUndefined();
  expect(cleanUsage({ ...good, by_model: null })?.by_model).toEqual({});
  expect(cleanUsage({ ...good, partial: "p".repeat(10_000) })?.partial).toHaveLength(500);
  const huge = Object.fromEntries(Array.from({ length: 200_000 }, (_, i) => [`m${i}`, m]));
  expect(Object.keys(cleanUsage({ ...good, by_model: huge })?.by_model ?? {})).toHaveLength(MAX_MODELS);
  expect(cleanUsage(null)).toBeUndefined();
  expect(cleanUsage("claude")).toBeUndefined();
});

test("usage is formatted on one line, even without its per-model split", () => {
  const u = cleanUsage({
    harness: "claude",
    session: "s",
    tokens: c(1, 2, 3, 4),
    by_model: { m: c(1, 2, 3, 4) },
    responses: 1,
    at: 5,
  });
  expect(u && formatUsage(u)).toBe("claude 1 in, 2 out, 3 cache write, 4 cache read (m)");
  expect(formatUsage({ ...(u as Usage), by_model: undefined as unknown as Usage["by_model"], partial: "p" })).toBe(
    "claude 1 in, 2 out, 3 cache write, 4 cache read (no model); partial: p",
  );
});

test("of two readings, a complete one wins, then the one with more responses", () => {
  const a = cleanUsage({
    harness: "claude",
    session: "s",
    tokens: c(1, 1),
    by_model: {},
    responses: 3,
    at: 1,
  }) as Usage;
  const b = { ...a, responses: 5 };
  expect(betterUsage(a, b)).toBe(b);
  expect(betterUsage(a, { ...a })).toBe(a);
  // A partial reading is a lower bound: it loses to a complete one only if that counted at least as much.
  const partialMore = { ...b, partial: "x" };
  expect(betterUsage(a, partialMore)).toBe(partialMore);
  expect(betterUsage(partialMore, a)).toBe(partialMore);
  const partialFewer = { ...a, responses: 2, partial: "x" };
  expect(betterUsage(partialFewer, a)).toBe(a);
  expect(betterUsage(a, partialFewer)).toBe(a);
  const partialSame = { ...a, partial: "x" };
  expect(betterUsage(partialSame, a)).toBe(a);
  // Another session's snapshot never displaces the report's own reading.
  const other = { ...b, session: "other" };
  expect(betterUsage(a, other)).toBe(a);
  expect(betterUsage(undefined, a)).toBe(a);
  expect(betterUsage(null, undefined)).toBeUndefined();
});
