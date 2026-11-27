/**
 * End to end for the result contract's handoff and token usage: a real server, a real client and
 * real tmux sessions with the shell harness, and synthetic Claude Code transcripts in a temp config dir.
 */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { specTempDir } from "../scripts/testkit";
import { CnocClient } from "../src/client/client";
import { Tmux } from "../src/client/tmux";
import type { ChangeEvent } from "../src/protocol";
import { CnocServer, type HostInfo, type JobInfo } from "../src/server/server";
import { STANDARD_TOTAL, standardSession } from "./transcript-fixture";

// Each test starts real tmux sessions and waits for client and server to agree, so one legitimately
// takes seconds. Each wait inside a test polls a condition (see `until`).
const E2E_TEST_TIMEOUT_MS = 40_000;
setDefaultTimeout(E2E_TEST_TIMEOUT_MS);
/** How often `until` looks again. */
const POLL_MS = 50;
/** How long `until` waits for a condition by default. */
const UNTIL_MS = 15_000;

const root = specTempDir("cnoc-report-e2e-");
const project = join(root, "proj");
// Not the socket test/e2e.test.ts uses: both files can run in one process.
const socket = `cnoc-test-report-${process.pid}`;
const quiet = () => {};
let server: CnocServer;
let client: CnocClient;
let seq = 0;

interface Res {
  status: number;
  job: JobInfo;
  hosts: HostInfo[];
  events: ChangeEvent[];
}

async function api(method: string, path: string, body?: unknown): Promise<Res> {
  const res = await fetch(`${server.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${server.adminToken}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, ...((await res.json()) as object) } as Res;
}

async function until<T>(
  what: string,
  fn: () => Promise<T | false | null | undefined> | T | false | null | undefined,
  ms = UNTIL_MS,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(POLL_MS);
  }
}

const id = (name: string) => `t/${name}-${++seq}`;
const job = (jobId: string, body: string) => `---\nid: ${jobId}\n---\nFROM proj\n${body}\n`;
const submit = (...bodies: string[]) => api("POST", "/v1/jobs", { jobs: bodies });
const state = async (jobId: string) => (await api("GET", `/v1/job?id=${encodeURIComponent(jobId)}`)).job;
const reaches = (jobId: string, want: string) =>
  until(`${jobId} to be ${want}`, async () => {
    const j = await state(jobId);
    return j?.state === want ? j : false;
  });
const events = async (): Promise<ChangeEvent[]> => (await api("GET", "/v1/events?after=0&limit=100000")).events;

beforeAll(async () => {
  mkdirSync(project, { recursive: true });
  server = await new CnocServer({ dataDir: join(root, "data"), port: 0, openEnrollment: true, log: quiet }).start();
  client = await new CnocClient({
    config: { server: server.url, name: "alpha", projects: { proj: project }, resources: { slots: 4 } },
    stateDir: join(root, "state-alpha"),
    tmuxSocket: socket,
    pollMs: 100,
    log: quiet,
  }).start();
  await until("alpha online", async () =>
    (await api("GET", "/v1/hosts")).hosts.find((h) => h.name === "alpha" && h.online),
  );
});

afterAll(async () => {
  await client.stop();
  await server.stop();
  await new Tmux(socket).killServer();
  // tmux leaves its socket file behind when the server is told to exit; it is outside the test's temp directory.
  rmSync(join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${process.getuid?.() ?? 0}`, socket), { force: true });
});

/** A synthetic Claude Code config dir with one session in it, and the job lines that point a session at it. */
function claudeSession(name: string) {
  const config = join(root, `claude-${name}`);
  const session = `sess-${name}`;
  const transcript = standardSession(config, session);
  const env = `ENV CLAUDE_CONFIG_DIR=${config}\nENV CLAUDE_CODE_SESSION_ID=${session}\n`;
  return { config, session, transcript, env };
}
const prompt = (cmd: string) => `HARNESS shell\nPROMPT ${JSON.stringify(cmd)}`;
const ofJob = (jobId: string, type: string) => async () =>
  (await events()).find((e) => e.type === type && e.job === jobId)?.data as Record<string, unknown> | undefined;

/** `cnoc show ID` against the test server. Asynchronous: the server answering it runs in this process. */
async function show(jobId: string): Promise<string> {
  const p = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "show", jobId], {
    env: { PATH: process.env.PATH ?? "", HOME: root, CNOC_URL: server.url, CNOC_TOKEN: server.adminToken },
    stdout: "pipe",
  });
  return new Response(p.stdout).text();
}

test("handoff MERGED ends the stage done, with its status and the session's tokens", async () => {
  const j = id("merged");
  const s = claudeSession("merged");
  await submit(job(j, `${s.env}${prompt('cnoc handoff merged -m "PR #88 merged"')}`));
  const done = await reaches(j, "done");
  expect(done.result).toEqual([
    {
      status: "done",
      summary: "PR #88 merged",
      handoff: "MERGED",
      usage: {
        harness: "claude",
        session: s.session,
        tokens: STANDARD_TOTAL,
        by_model: {
          "claude-opus-test": { input: 15, output: 50, cache_creation: 100, cache_read: 100 },
          "claude-sonnet-test": { input: 1, output: 7, cache_creation: 3, cache_read: 4 },
        },
        responses: 3,
        at: expect.any(Number),
      },
    },
  ]);
  const ended = await ofJob(j, "attempt.ended")();
  expect(ended).toMatchObject({ outcome: "done", handoff: "MERGED", usage: [{ tokens: STANDARD_TOTAL }] });
  expect(await ofJob(j, "job.terminal")()).toEqual({ state: "done", reason: null, handoff: "MERGED" });

  const out = await show(j);
  expect(out).toContain("stage 1: done  handoff MERGED  PR #88 merged");
  expect(out).toContain("tokens: claude 16 in, 57 out, 103 cache write, 104 cache read");
});

test("handoff BLOCKED ends the stage failed with the reason, and a subscriber can tell it from a crash", async () => {
  const j = id("handed-back");
  const s = claudeSession("blocked");
  await submit(job(j, `${s.env}${prompt('cnoc handoff BLOCKED -m "review is stuck"')}`));
  const failed = await reaches(j, "failed");
  expect(failed.reason).toBe("stage 1 failed: review is stuck");
  expect(failed.result).toMatchObject([
    { status: "failed", summary: "review is stuck", handoff: "BLOCKED", usage: { tokens: STANDARD_TOTAL } },
  ]);
  expect(await ofJob(j, "job.terminal")()).toEqual({
    state: "failed",
    reason: "stage 1 failed: review is stuck",
    handoff: "BLOCKED",
  });
});

test("a usage snapshot from a Stop hook is kept for a stage that ends without a report", async () => {
  const j = id("snapshot");
  const s = claudeSession("snapshot");
  // What Claude Code hands a Stop hook on stdin; the session itself has no session variable here.
  const hook = join(root, "stop-hook.json");
  writeFileSync(hook, JSON.stringify({ session_id: s.session, transcript_path: s.transcript }));
  await submit(job(j, prompt(`cnoc usage < ${hook} && cnoc progress snapped && sleep 60`)));
  await until("the snapshot to be taken", ofJob(j, "attempt.progress"));
  await api("POST", `/v1/job/cancel?id=${encodeURIComponent(j)}`);
  const cancelled = await reaches(j, "cancelled");
  expect(cancelled.result).toMatchObject([
    { status: "failed", reported: false, usage: { session: s.session, tokens: STANDARD_TOTAL } },
  ]);
  expect(await ofJob(j, "attempt.ended")()).toMatchObject({ outcome: "cancelled", usage: [{ responses: 3 }] });
});

test("a multi-stage job carries each stage's usage, and the handoff only of the stage that ended it", async () => {
  const s = claudeSession("multi");
  const two = (second: string) => `${s.env}${prompt('cnoc handoff merged -m "one"')}\nPROMPT ${JSON.stringify(second)}`;

  const finished = id("multi-done");
  await submit(job(finished, two('cnoc handoff MERGED -m "two"')));
  await reaches(finished, "done");
  expect(await ofJob(finished, "attempt.ended")()).toMatchObject({
    outcome: "done",
    handoff: "MERGED",
    usage: [{ tokens: STANDARD_TOTAL }, { tokens: STANDARD_TOTAL }],
  });

  // Stage 1 hands off MERGED; stage 2 is cancelled after only a snapshot. The job did not end MERGED.
  const hook = join(root, "multi-hook.json");
  writeFileSync(hook, JSON.stringify({ session_id: s.session, transcript_path: s.transcript }));
  const stopped = id("multi-cancelled");
  await submit(job(stopped, two(`cnoc usage < ${hook} && cnoc progress snapped && sleep 60`)));
  await until("the second stage's snapshot", ofJob(stopped, "attempt.progress"));
  await api("POST", `/v1/job/cancel?id=${encodeURIComponent(stopped)}`);
  const cancelled = await reaches(stopped, "cancelled");
  expect(cancelled.result).toMatchObject([
    { status: "done", handoff: "MERGED", usage: { responses: 3 } },
    { reported: false, usage: { responses: 3 } },
  ]);
  const ended = await ofJob(stopped, "attempt.ended")();
  expect(ended).toMatchObject({ outcome: "cancelled", usage: [{ responses: 3 }, { responses: 3 }] });
  expect(ended?.handoff).toBeUndefined();
  expect((await ofJob(stopped, "job.terminal")())?.handoff).toBeUndefined();
  expect(await show(stopped)).toContain("stage 2: no report  ");
});
