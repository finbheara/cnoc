/**
 * The session side of reporting: `cnoc handoff` parsing, the client's check of a reported result,
 * the changelog fields, the CLI as a process, and the runner's handling of usage snapshots.
 */
import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { specTempDir } from "../scripts/testkit";
import { AttemptRunner, type AttemptState, REPORT } from "../src/client/runner";
import type { PaneStatus, Tmux } from "../src/client/tmux";
import type { JobSpec, StageResult, Usage } from "../src/protocol";
import { HANDOFF, parseHandoff, readResult, reportedFields, wrongStage } from "../src/report";
import { STANDARD_TOTAL, standardSession } from "./transcript-fixture";

const root = specTempDir("cnoc-report-");
const CLI = resolve(import.meta.dir, "../src/cli.ts");

const usage = (output: number): Usage => ({
  harness: "claude",
  session: "s",
  tokens: { input: 1, output, cache_creation: 0, cache_read: 0 },
  by_model: { m: { input: 1, output, cache_creation: 0, cache_read: 0 } },
  responses: 1,
  at: 1,
});

// ---- handoff -----------------------------------------------------------------

test("handoff takes its status in any case and its message from -m, --message or trailing words", () => {
  expect(parseHandoff(["merged"])).toEqual({ status: "done", handoff: "MERGED", summary: "MERGED" });
  expect(parseHandoff(["Merged", "-m", "PR #88"])).toEqual({ status: "done", handoff: "MERGED", summary: "PR #88" });
  expect(parseHandoff(["BLOCKED", "--message", "needs a decision"])).toMatchObject({
    status: "failed",
    handoff: "BLOCKED",
    summary: "needs a decision",
  });
  expect(parseHandoff(["blocked", "-m=review", "is", "stuck"]).summary).toBe("review is stuck");
  expect(parseHandoff(["blocked", "ci", "is", "red"]).summary).toBe("ci is red");
});

test("an unknown handoff status is refused with the valid ones; BLOCKED needs a reason", () => {
  expect(Object.keys(HANDOFF)).toEqual(["MERGED", "BLOCKED"]);
  expect(() => parseHandoff(["SHIPPED"])).toThrow("unknown handoff status SHIPPED; use one of MERGED, BLOCKED");
  expect(() => parseHandoff([])).toThrow(/missing STATUS/);
  expect(() => parseHandoff(["BLOCKED"])).toThrow('cnoc handoff BLOCKED needs a reason: -m "reason"');
  expect(() => parseHandoff(["BLOCKED", "-m", ""])).toThrow(/needs a reason/);
});

test("the client checks a reported result, its handoff and its usage", () => {
  expect(readResult({ status: "done", summary: "ok" })).toEqual({ status: "done", summary: "ok" });
  expect(readResult({ status: "failed", summary: "why", handoff: "blocked", usage: usage(2) })).toEqual({
    status: "failed",
    summary: "why",
    handoff: "BLOCKED",
    usage: usage(2),
  });
  expect(readResult({ status: "done", summary: "x", usage: { harness: 1 } })).toEqual({ status: "done", summary: "x" });
  expect(readResult({ status: "weird" })).toBe("status must be done or failed");
  expect(readResult({ status: "done", handoff: "BLOCKED" })).toBe("handoff BLOCKED means failed, not done");
  expect(readResult({ status: "done", handoff: "NOPE" })).toMatch(/^unknown handoff status NOPE/);
});

test("the changelog carries the last stage's handoff and each stage's usage", () => {
  const plain: StageResult = { status: "done", summary: "a" };
  const merged: StageResult = { status: "done", summary: "m", handoff: "MERGED" };
  expect(reportedFields([plain], "done")).toEqual({ handoff: {}, usage: {} });
  expect(
    reportedFields(
      [
        { ...plain, usage: usage(1) },
        { status: "failed", summary: "b", handoff: "BLOCKED" },
      ],
      "failed",
    ),
  ).toEqual({ handoff: { handoff: "BLOCKED" }, usage: { usage: [usage(1), null] } });
  expect(reportedFields([plain, merged], "done").handoff).toEqual({ handoff: "MERGED" });
});

test("an earlier stage's handoff does not stand for a later stage that ended without a report", () => {
  const merged: StageResult = { status: "done", summary: "m", handoff: "MERGED" };
  // Stage 2 timed out, failed to launch or was cancelled, and left no entry.
  expect(reportedFields([merged], "failed").handoff).toEqual({});
  expect(reportedFields([merged], "cancelled").handoff).toEqual({});
  // Or left only its usage snapshot.
  const unreported: StageResult = { status: "failed", summary: "timeout", usage: usage(2), reported: false };
  expect(reportedFields([merged, unreported], "failed")).toEqual({
    handoff: {},
    usage: { usage: [null, usage(2)] },
  });
});

test("a session command from a stage that is over is refused", () => {
  expect(wrongStage({ stage: 2 }, 2)).toBeNull();
  expect(wrongStage({}, 2)).toBeNull();
  expect(wrongStage({ stage: 1 }, 2)).toBe("stage 1 is over; this attempt is on stage 2");
});

test("the appended instructions defer to a closing command the prompt names", () => {
  expect(REPORT).toBe(
    "When you finish, report once: if the task above names a closing command (cnoc done, fail or handoff), run that. " +
      'Otherwise run `cnoc done "<one-line summary>"`, or `cnoc fail "<reason>"` if it cannot be completed. ' +
      'Use `cnoc progress "<note>"` for milestones.',
  );
});

// ---- the CLI as a process ------------------------------------------------------

async function cli(args: string[], env: Record<string, string>, stdin?: string) {
  const p = Bun.spawn([process.execPath, CLI, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: root, ...env },
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

test("cnoc usage is silent and exits 0 outside a job and when the socket is not there", async () => {
  expect(await cli(["usage"], {})).toEqual({ out: "", err: "", code: 0 });
  const config = join(root, "cli-cfg");
  standardSession(config, "cli-sess");
  const env = { CNOC_SOCK: join(root, "no-such-sock"), CNOC_TOKEN: "t", CLAUDE_CONFIG_DIR: config };
  expect(await cli(["usage"], { ...env, CLAUDE_CODE_SESSION_ID: "cli-sess" })).toEqual({ out: "", err: "", code: 0 });
  expect(await cli(["usage"], env, "not json")).toEqual({ out: "", err: "", code: 0 });
});

test("cnoc usage --print reads a hook's stdin and shows what it found", async () => {
  const file = standardSession(join(root, "print-cfg"), "print-sess");
  const r = await cli(["usage", "--print"], {}, JSON.stringify({ session_id: "print-sess", transcript_path: file }));
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out)).toMatchObject({ harness: "claude", session: "print-sess", tokens: STANDARD_TOTAL });
});

test("a FIFO in place of a transcript neither hangs a report nor a snapshot", async () => {
  const config = join(root, "fifo-cfg");
  mkdirSync(join(config, "projects", "-work-myapp"), { recursive: true });
  const fifo = join(config, "projects", "-work-myapp", "fifo-sess.jsonl");
  expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
  const hook = JSON.stringify({ session_id: "fifo-sess", transcript_path: fifo });
  expect(await cli(["usage", "--print"], { CLAUDE_CONFIG_DIR: config }, hook)).toEqual({
    out: "null\n",
    err: "",
    code: 0,
  });
  // A report still goes out: here it fails only because there is no client on the socket.
  const env = { CNOC_SOCK: join(root, "no-such-sock"), CNOC_TOKEN: "t", CNOC_STAGE: "1", CLAUDE_CONFIG_DIR: config };
  const done = await cli(["done", "ok"], { ...env, CLAUDE_CODE_SESSION_ID: "fifo-sess" });
  expect(done.code).toBe(1);
  expect(done.err).toStartWith(`cnoc: cannot reach ${env.CNOC_SOCK}`);
});

test("cnoc handoff refuses a bad status before it looks for a job", async () => {
  const bad = await cli(["handoff", "shipped"], {});
  expect(bad.code).toBe(1);
  expect(bad.err).toBe("cnoc: unknown handoff status shipped; use one of MERGED, BLOCKED\n");
  const outside = await cli(["handoff", "merged"], {});
  expect(outside.err).toBe("cnoc: not inside a Cnoc job (CNOC_SOCK is not set)\n");
});

// ---- the runner ------------------------------------------------------------------

/** Just enough tmux for one stage: a session that runs until it is told otherwise. */
class FakeTmux {
  env: Record<string, string> | null = null;
  pane: PaneStatus = { state: "gone" };
  async newSession(_n: string, _cwd: string, env: Record<string, string>): Promise<void> {
    this.env = env;
    this.pane = { state: "running" };
  }
  async status(): Promise<PaneStatus> {
    return this.pane;
  }
  async capture(): Promise<string> {
    return "";
  }
  async kill(): Promise<void> {
    this.pane = { state: "gone" };
  }
  async sendText(): Promise<void> {}
  async sendKey(): Promise<void> {}
}

const spec = (env: Record<string, string> = {}): JobSpec => ({
  id: "myapp/1",
  project: "myapp",
  priority: 0,
  resources: { slots: 1 },
  requires: [],
  depends: [],
  time_s: null,
  labels: {},
  env,
  stages: [{ harness: "fake", args: "", prompt: "p" }],
});

function runner(jobEnv: Record<string, string> = {}) {
  const tmux = new FakeTmux();
  let started: () => void = () => {};
  const ready = new Promise<void>((r) => {
    started = r;
  });
  const state: AttemptState = {
    attempt: 1,
    spec: spec(jobEnv),
    token: "tok",
    stage: 0,
    phase: "launching",
    deadline: null,
    results: [],
    reported: null,
  };
  const r = new AttemptRunner(
    state,
    {
      tmux: tmux as unknown as Tmux,
      adapter: () => ({ requires: [], steps: [{ op: "tmux", cmd: "run" }], stop: [] }),
      projectPath: () => root,
      baseEnv: {},
      save: () => {},
      onStarted: () => started(),
      writeLog: () => {},
      pollMs: 1,
    },
    false,
  );
  return { r, tmux, ready, run: r.run() };
}

test("a report without usage takes the stage's latest snapshot", async () => {
  const { r, ready, run } = runner();
  await ready;
  r.snapshot(usage(1));
  r.snapshot(usage(5));
  r.report({ status: "done", summary: "ok" });
  expect((await run).results).toEqual([{ status: "done", summary: "ok", usage: usage(5) }]);
});

test("a complete reading wins over a partial one, then the one with more responses", async () => {
  const partial = runner();
  await partial.ready;
  partial.r.snapshot(usage(5));
  partial.r.report({ status: "done", summary: "ok", usage: { ...usage(0), responses: 9, partial: "unreadable" } });
  expect((await partial.run).results[0]?.usage).toEqual(usage(5));

  const fewer = runner();
  await fewer.ready;
  fewer.r.snapshot({ ...usage(5), responses: 4 });
  fewer.r.report({ status: "done", summary: "ok", usage: { ...usage(6), responses: 2 } });
  expect((await fewer.run).results[0]?.usage).toEqual({ ...usage(5), responses: 4 });
});

test("a report that carries usage keeps its own", async () => {
  const { r, ready, run } = runner();
  await ready;
  r.snapshot(usage(1));
  r.report({ status: "done", summary: "ok", handoff: "MERGED", usage: usage(9) });
  expect((await run).results).toEqual([{ status: "done", summary: "ok", handoff: "MERGED", usage: usage(9) }]);
});

test("a stage that ends without a report keeps its snapshot as an unreported result", async () => {
  const cancelled = runner();
  await cancelled.ready;
  cancelled.r.snapshot(usage(3));
  cancelled.r.cancel("by test");
  expect(await cancelled.run).toMatchObject({
    outcome: "cancelled",
    reason: "by test",
    results: [{ status: "failed", summary: "by test", usage: usage(3), reported: false }],
  });

  const exited = runner();
  await exited.ready;
  exited.r.snapshot(usage(4));
  exited.tmux.pane = { state: "dead", exit: 1 };
  expect(await exited.run).toMatchObject({
    outcome: "failed",
    reason: "no-result (exit 1)",
    results: [{ summary: "no-result (exit 1)", usage: usage(4), reported: false }],
  });

  const bare = runner();
  await bare.ready;
  bare.r.cancel("no snapshot");
  expect((await bare.run).results).toEqual([]);
});

test("a session never inherits a harness session id, but a job's ENV may set one", async () => {
  const plain = runner();
  await plain.ready;
  expect(plain.tmux.env?.CLAUDE_CODE_SESSION_ID).toBe("");
  plain.r.cancel("done looking");
  await plain.run;

  const set = runner({ CLAUDE_CODE_SESSION_ID: "from-the-job" });
  await set.ready;
  expect(set.tmux.env?.CLAUDE_CODE_SESSION_ID).toBe("from-the-job");
  set.r.cancel("done looking");
  await set.run;
});
