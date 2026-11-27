import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { specTempDir } from "../scripts/testkit";
import {
  DEFAULT_MAX,
  EXIT_FATAL,
  type FeedDeps,
  type FeedOptions,
  type FeedServer,
  type RunRequest,
  feed,
  feedPass,
  parseFeedArgs,
  parseFeedLine,
} from "../src/feed";

/** Long enough for a fake server to answer; the one that never answers takes forever. */
const SHORT_REQUEST_TIMEOUT_MS = 300;

const dir = specTempDir("cnoc-feed-");
let n = 0;
/** A source command that prints `lines` and then exits with `status`. */
const source = (lines: string[], status = 0): string[] => {
  const file = join(dir, `lines-${++n}.txt`);
  writeFileSync(file, lines.map((l) => `${l}\n`).join(""));
  return ["sh", "-c", `cat "$0"; exit ${status}`, file];
};
const line = (o: object) => JSON.stringify(o);

const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

/** A server that knows each run by its key, and records what it was sent. `over` replaces its calls. */
function fake(over: Partial<FeedServer> = {}) {
  const seen = new Set<string>();
  const calls: Array<{ ref: string; body: RunRequest }> = [];
  let healthChecks = 0;
  const run: FeedServer["run"] = async (ref, body) => {
    if (ref === "missing") throw httpError(404, `no template ${ref}`);
    if (!body.key) throw httpError(400, "lane declares no key and none was given");
    const id = `${ref}/${body.key}`;
    const created = !seen.has(id);
    seen.add(id);
    return { job: { id, state: "queued" }, template: {}, created, state: "queued", seq: 1 };
  };
  const server: FeedServer = {
    health: async (signal) => {
      healthChecks++;
      return over.health ? over.health(signal) : { ok: true, features: ["keyed-runs"] };
    },
    run: async (ref, body, signal) => {
      calls.push({ ref, body });
      return (over.run ?? run)(ref, body, signal);
    },
  };
  const out: string[] = [];
  const err: string[] = [];
  const deps: FeedDeps = { server, log: (l) => out.push(l), warn: (l) => err.push(l) };
  return { calls, out, err, deps, healthChecks: () => healthChecks };
}
const opts = (command: string[], over: Partial<FeedOptions> = {}): FeedOptions => ({
  command,
  max: DEFAULT_MAX,
  dryRun: false,
  ...over,
});

test("a line is a template run with optional key, arguments and scheduling", () => {
  expect(
    parseFeedLine(
      line({
        template: "lane",
        key: "myapp-1",
        set: { PROJECT: "myapp", ISSUE: 1 },
        priority: 5,
        on: "workbox",
        begin: "+2h",
      }),
      3,
    ),
  ).toEqual({
    line: 3,
    ref: "lane",
    body: {
      key: "myapp-1",
      set: { PROJECT: "myapp", ISSUE: "1" },
      overrides: { priority: 5, on: "workbox", begin: "+2h" },
      keyed: true,
    },
  });
  expect(parseFeedLine(line({ template: 4 }), 1)).toEqual({
    line: 1,
    ref: "4",
    body: { set: {}, overrides: {}, keyed: true },
  });
  expect(parseFeedLine(line({ template: "lane", key: null, set: null, priority: null }), 2)).toEqual({
    line: 2,
    ref: "lane",
    body: { set: {}, overrides: {}, keyed: true },
  });
  expect(parseFeedLine("   ", 2)).toBeNull();
});

test("a malformed line says what is wrong with it", () => {
  const bad = (text: string) => parseFeedLine(text, 1);
  expect(bad("{nope")).toMatch(/^not JSON/);
  expect(bad("[1]")).toBe("not a JSON object");
  expect(bad(line({ key: "k" }))).toMatch(/"template" must be a name or a number/);
  expect(bad(line({ template: "lane", project: "x" }))).toBe('unknown field "project"');
  expect(bad(line({ template: "lane", key: 7 }))).toMatch(/"key" must be/);
  expect(bad(line({ template: "lane", set: { A: { b: 1 } } }))).toBe('"set.A" must be a string or a whole number');
  expect(bad('{"template":"lane","set":{"ISSUE":12345678901234567890}}')).toBe(
    '"set.ISSUE" is a number JSON cannot carry exactly; send it as a string',
  );
  expect(bad(line({ template: "lane", set: { ISSUE: 1e21 } }))).toMatch(/send it as a string/);
  expect(bad(line({ template: "lane", set: { ISSUE: 1.5 } }))).toMatch(/send it as a string/);
  expect(bad('{"template":"lane","set":{"__proto__":"x"}}')).toBe(
    '"set" name "__proto__" is not an ARG name (capitals, digits, _)',
  );
  expect(bad(line({ template: "lane", set: { project: "x" } }))).toMatch(/not an ARG name/);
  expect(bad(line({ template: "lane", priority: 1.5 }))).toMatch(/"priority"/);
  expect(bad(line({ template: "lane", on: "" }))).toMatch(/"on"/);
  expect(bad(line({ template: "lane", begin: 3 }))).toMatch(/"begin"/);
});

test("options come before --, and everything after it is the command", () => {
  expect(parseFeedArgs(["--", "sh", "-c", "x"])).toEqual({
    command: ["sh", "-c", "x"],
    max: DEFAULT_MAX,
    dryRun: false,
  });
  expect(parseFeedArgs(["--every", "5m", "--max=3", "--dry-run", "--", "src", "--max", "9"])).toEqual({
    command: ["src", "--max", "9"],
    everyS: 300,
    max: 3,
    dryRun: true,
  });
  expect(() => parseFeedArgs(["--max", "0", "--", "x"])).toThrow(/--max takes a whole number/);
  expect(() => parseFeedArgs(["--every", "soon", "--", "x"])).toThrow(/--every: bad duration/);
  expect(() => parseFeedArgs(["--max", "2"])).toThrow(/missing COMMAND/);
  expect(() => parseFeedArgs(["src", "--", "x"])).toThrow(/unknown option src/);
});

test("a second pass over the same backlog creates nothing; a new line creates one", async () => {
  const f = fake();
  const backlog = [line({ template: "lane", key: "a" }), line({ template: "lane", key: "b" })];
  expect(await feedPass(opts(source(backlog)), f.deps)).toEqual({ created: 2, existing: 0, rejected: 0, heldBack: 0 });
  expect(await feedPass(opts(source(backlog)), f.deps)).toEqual({ created: 0, existing: 2, rejected: 0, heldBack: 0 });
  expect(await feedPass(opts(source([...backlog, line({ template: "lane", key: "c" })])), f.deps)).toMatchObject({
    created: 1,
    existing: 2,
  });
  expect(f.out).toEqual([
    "[feed] created lane/a (queued)",
    "[feed] created lane/b (queued)",
    "[feed] pass: 2 created, 0 already there, 0 rejected",
    "[feed] pass: 0 created, 2 already there, 0 rejected",
    "[feed] created lane/c (queued)",
    "[feed] pass: 1 created, 2 already there, 0 rejected",
  ]);
  expect(f.err).toEqual([]);
  expect(f.calls.every((c) => c.body.keyed === true)).toBe(true);
});

test("bad lines and refused runs are reported by line number, and the other lines still go", async () => {
  const f = fake();
  const cmd = source([
    line({ template: "lane", key: "a" }),
    "not json",
    "",
    line({ template: "missing", key: "b" }),
    line({ template: "lane" }),
    line({ template: "lane", key: "c" }),
  ]);
  const r = await feedPass(opts(cmd), f.deps);
  expect(r).toEqual({ created: 2, existing: 0, rejected: 3, heldBack: 0 });
  expect(f.err).toEqual([
    expect.stringMatching(/^\[feed\] line 2 rejected: not JSON/),
    "[feed] line 4 rejected by the server: no template missing",
    "[feed] line 5 rejected by the server: lane declares no key and none was given",
  ]);
  expect(f.out.at(-1)).toBe("[feed] pass: 2 created, 0 already there, 3 rejected");
  expect(await feed(opts(cmd), fake().deps)).toBe(1);
});

test("--max caps new jobs per pass; existing ones do not count, and the rest wait", async () => {
  const f = fake();
  const backlog = ["a", "b", "c", "d", "e"].map((key) => line({ template: "lane", key }));
  await feedPass(opts(source(backlog.slice(0, 1))), f.deps);
  expect(await feedPass(opts(source(backlog), { max: 2 }), f.deps)).toEqual({
    created: 2,
    existing: 1,
    rejected: 0,
    heldBack: 2,
  });
  expect(f.out.at(-1)).toBe("[feed] pass: 2 created, 1 already there, 0 rejected, 2 held back by --max 2");
  expect(await feedPass(opts(source(backlog), { max: 2 }), f.deps)).toMatchObject({ created: 2, heldBack: 0 });
  expect(f.calls.map((c) => c.body.key)).toEqual(["a", "a", "b", "c", "a", "b", "c", "d", "e"]);
});

test("a command that fails submits nothing, even what it printed first", async () => {
  const f = fake();
  const cmd = source([line({ template: "lane", key: "a" })], 3);
  expect(await feedPass(opts(cmd), f.deps)).toMatchObject({ created: 0, failure: "command exited with status 3" });
  expect(f.calls).toEqual([]);
  expect(f.err).toEqual(["[feed] command exited with status 3; nothing submitted this pass"]);
  expect(await feed(opts(cmd), f.deps)).toBe(1);
  expect(await feed(opts(["/nonexistent/source"]), f.deps)).toBe(1);
  expect(f.err.at(-1)).toMatch(/^\[feed\] command cannot start \/nonexistent\/source: .*; nothing submitted/);
});

test("the source's stderr is repeated in the log", async () => {
  const f = fake();
  await feedPass(opts(["sh", "-c", "echo 'rate limited' >&2"]), f.deps);
  expect(f.err).toEqual(["[feed] source: rate limited"]);
  expect(f.out).toEqual(["[feed] pass: 0 created, 0 already there, 0 rejected"]);
});

test("a server without keyed runs gets no submission at all, and the feeder exits 78", async () => {
  // An older server answers health without features and would make a numbered job of every run.
  const old = fake({ health: async () => ({ ok: true, version: "0.1.0", protocol: 1 }) });
  const backlog = source([line({ template: "lane", key: "a" })]);
  expect(await feed(opts(backlog), old.deps)).toBe(EXIT_FATAL);
  expect(await feed(parseFeedArgs(["--every", "1s", "--", ...backlog]), old.deps)).toBe(EXIT_FATAL);
  expect(old.calls).toEqual([]);
  expect(old.err.at(-1)).toMatch(/does not do keyed template runs.*not retrying \(exit 78\)$/);

  // A server that says it does, but answers without `created`, stops the feeder after one run.
  const liar = fake({ run: async (ref) => ({ job: { id: `${ref}/1`, state: "queued" } }) });
  expect(
    await feed(opts(source([line({ template: "lane", key: "a" }), line({ template: "lane", key: "b" })])), liar.deps),
  ).toBe(EXIT_FATAL);
  expect(liar.calls.length).toBe(1);
});

test("a refused token stops the feeder with 78, in a loop too", async () => {
  for (const status of [401, 403]) {
    const f = fake({ run: async () => Promise.reject(httpError(status, "bad token")) });
    const backlog = source([line({ template: "lane", key: "a" }), line({ template: "lane", key: "b" })]);
    expect(await feed(parseFeedArgs(["--every", "1s", "--", ...backlog]), f.deps)).toBe(EXIT_FATAL);
    expect(f.calls.length).toBe(1);
    expect(f.err.at(-1)).toBe(`[feed] the server refused the token (${status}): bad token; not retrying (exit 78)`);
  }
});

test("health is asked once, before the first submission, and not for an empty backlog", async () => {
  const f = fake();
  await feed(opts(source([])), f.deps);
  expect(f.healthChecks()).toBe(0);
  const stop = new AbortController();
  let passes = 0;
  const log = (l: string) => {
    if (l.startsWith("[feed] pass:") && ++passes === 3) stop.abort();
  };
  await feed(opts(source([line({ template: "lane", key: "a" })]), { everyS: 0 }), {
    ...f.deps,
    log,
    signal: stop.signal,
  });
  expect(f.healthChecks()).toBe(1);
});

test("a lost server, a server error or a malformed answer stops the pass after what was created", async () => {
  const backlog = source(["a", "b", "c"].map((key) => line({ template: "lane", key })));
  const cases: Array<[FeedServer["run"], string]> = [
    [
      async () => Promise.reject(new Error("cannot reach http://127.0.0.1:1: Connection refused")),
      "cannot reach http://127.0.0.1:1: Connection refused",
    ],
    [async () => Promise.reject(httpError(500, "database is locked")), "database is locked"],
    [async () => null, "the server's answer has no job: null"],
    [async () => ({ created: true }), 'the server\'s answer has no job: {"created":true}'],
  ];
  for (const [broken, why] of cases) {
    let n = 0;
    const f = fake();
    const ok = f.deps.server.run;
    const g = fake({
      run: async (ref, body, signal) => (++n === 3 ? broken(ref, body, signal) : ok(ref, body, signal)),
    });
    const r = await feedPass(opts(backlog), g.deps);
    expect(r).toEqual({ created: 2, existing: 0, rejected: 0, heldBack: 0, failure: why });
    expect(g.err).toEqual([
      `[feed] pass stopped at line 3: ${why}`,
      "[feed] pass: 2 created, 0 already there, 0 rejected (stopped early)",
    ]);
    expect(await feed(opts(backlog), fake({ run: broken }).deps)).toBe(1);
  }
});

test("a stop during submission sends nothing more, and a request that is never answered times out", async () => {
  const stop = new AbortController();
  const backlog = source(["a", "b", "c"].map((key) => line({ template: "lane", key })));
  const f = fake();
  const ok = f.deps.server.run;
  const g = fake({
    run: async (ref, body, signal) => {
      if (body.key === "b") stop.abort();
      return ok(ref, body, signal);
    },
  });
  const r = await feedPass(opts(backlog), { ...g.deps, signal: stop.signal });
  expect(g.calls.map((c) => c.body.key)).toEqual(["a", "b"]);
  // The stop came while b was in flight, so its answer is not waited for; c is never sent.
  expect(r).toMatchObject({ created: 1, failure: "stopped" });

  // A server that takes the request and never answers: a stop ends the wait, and so does the timeout.
  const hang: FeedServer["run"] = (_ref, _body, signal) =>
    new Promise((_, fail) => signal.addEventListener("abort", () => fail(new Error("aborted"))));
  const stop2 = new AbortController();
  const h = fake({
    run: (ref, body, signal) => {
      stop2.abort();
      return hang(ref, body, signal);
    },
  });
  expect(await feedPass(opts(backlog), { ...h.deps, signal: stop2.signal })).toMatchObject({ failure: "stopped" });
  expect(h.calls.length).toBe(1);
  const t = fake({ run: hang });
  expect(await feedPass(opts(backlog), { ...t.deps, requestTimeoutMs: SHORT_REQUEST_TIMEOUT_MS })).toMatchObject({
    failure: `no answer from the server in ${SHORT_REQUEST_TIMEOUT_MS / 1000}s`,
  });
});

test("a looping feeder logs a failed pass and carries on until it is stopped", async () => {
  const f = fake();
  const stop = new AbortController();
  const marker = join(dir, "loop-count");
  writeFileSync(marker, "");
  // Fails on its first pass, then lists one item.
  const cmd = [
    "sh",
    "-c",
    `echo x >> "$0"; [ "$(wc -l < "$0")" -gt 1 ] || exit 1; echo '${line({ template: "lane", key: "a" })}'`,
    marker,
  ];
  let summaries = 0;
  const log = (l: string) => {
    f.out.push(l);
    if (l.startsWith("[feed] pass:") && ++summaries === 2) stop.abort();
  };
  expect(await feed(opts(cmd, { everyS: 0 }), { ...f.deps, log, signal: stop.signal })).toBe(0);
  expect(f.err).toEqual(["[feed] command exited with status 1; nothing submitted this pass"]);
  expect(f.out).toEqual([
    `[feed] every 0s, at most 10 new jobs a pass: ${cmd.join(" ")}`,
    "[feed] created lane/a (queued)",
    "[feed] pass: 1 created, 0 already there, 0 rejected",
    "[feed] pass: 0 created, 1 already there, 0 rejected",
  ]);
});

test("a dry run prints what would be offered and submits nothing", async () => {
  const f = fake();
  const cmd = source([line({ template: "lane", key: "a", set: { ISSUE: "1" }, on: "workbox" }), "{"]);
  expect(await feedPass(opts(cmd, { dryRun: true }), f.deps)).toMatchObject({ created: 0, rejected: 1 });
  expect(f.calls).toEqual([]);
  expect(f.out).toEqual([
    "[feed] would offer line 1: lane key a ISSUE=1 on workbox",
    "[feed] dry run: 1 would be offered, 1 rejected",
  ]);
});
