/**
 * End to end: a real server, real clients and real tmux sessions, using the shell harness.
 */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { specTempDir } from "../scripts/testkit";
import { type ClientConfig, CnocClient } from "../src/client/client";
import { Tmux } from "../src/client/tmux";
import type { ChangeEvent } from "../src/protocol";
import { CnocServer, type HostInfo, type JobInfo } from "../src/server/server";
import type { AttemptRow, TemplateRow } from "../src/server/store";

// Every test here starts real tmux sessions and waits for a client and a server to agree about them,
// so one test legitimately takes seconds. Each wait inside a test polls a condition (see `until`).
const E2E_TEST_TIMEOUT_MS = 40_000;
setDefaultTimeout(E2E_TEST_TIMEOUT_MS);
/** How often `until` looks again. */
const POLL_MS = 50;

const root = specTempDir("cnoc-e2e-");
const project = join(root, "proj");
const socket = `cnoc-test-${process.pid}`;
const quiet = () => {};
/** Every test client's checkout unless it brings its own: not a git checkout, so a test that gets the versions wrong can never move this repository. */
const noCheckout = join(root, "not-a-checkout");
let server: CnocServer;
let client: CnocClient;
let seq = 0;

const config = (name: string, over: Partial<ClientConfig> = {}): ClientConfig => ({
  server: server.url,
  name,
  projects: { proj: project },
  resources: { slots: 4, solo: 1 },
  ...over,
});
const newClient = (
  name: string,
  over: Partial<ClientConfig> = {},
  extra: { version?: string; exit?: (c: number) => void } = {},
) =>
  new CnocClient({
    config: config(name, over),
    stateDir: join(root, `state-${name}`),
    tmuxSocket: socket,
    pollMs: 100,
    log: quiet,
    checkout: noCheckout,
    ...extra,
  });

/**
 * Every field these tests read from a response. One route sends a few of them; a test reads only
 * what its route sends, and an assertion on a field the route did not send fails as undefined.
 */
interface Res {
  status: number;
  error: string;
  /** `GET /v1/jobs` lists jobs; `POST /v1/jobs` answers with id, state and created for each. */
  jobs: Array<{ id: string; state: string; created?: boolean }>;
  job: JobInfo;
  host: HostInfo;
  as_of: number;
  attempts: AttemptRow[];
  hosts: HostInfo[];
  events: ChangeEvent[];
  templates: TemplateRow[];
  template: TemplateRow;
  /** `POST /v1/template/run`: false when a keyed run's job already existed. */
  created: boolean;
  state: string;
  result: string;
  subscription: { id: number; secret: string };
}

async function api(method: string, path: string, body?: unknown, srv: CnocServer = server): Promise<Res> {
  const res = await fetch(`${srv.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${srv.adminToken}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, ...((await res.json()) as object) } as Res;
}

async function firstAttempt(jobId: string): Promise<number> {
  const [attempt] = (await api("GET", `/v1/job?id=${encodeURIComponent(jobId)}`)).attempts;
  if (!attempt) throw new Error(`${jobId} has no attempt`);
  return attempt.id;
}

async function until<T>(
  what: string,
  fn: () => Promise<T | false | null | undefined> | T | false | null | undefined,
  ms = 15_000,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(POLL_MS);
  }
}

/** A unique job id per call, so tests do not collide in the shared server. */
const id = (name: string) => `t/${name}-${++seq}`;
const job = (jobId: string, cmd: string, front = "", harnessLines?: string) =>
  `---\nid: ${jobId}\n${front}\n---\nFROM proj\n${harnessLines ?? `HARNESS shell\nPROMPT ${JSON.stringify(cmd)}`}\n`;
const submit = (...bodies: string[]) => api("POST", "/v1/jobs", { jobs: bodies });
const state = async (jobId: string, srv: CnocServer = server) =>
  (await api("GET", `/v1/job?id=${encodeURIComponent(jobId)}`, undefined, srv)).job;
const reaches = (jobId: string, want: string, srv: CnocServer = server) =>
  until(`${jobId} to be ${want}`, async () => {
    const j = await state(jobId, srv);
    return j?.state === want ? j : false;
  });
const events = async (): Promise<ChangeEvent[]> => (await api("GET", "/v1/events?after=0&limit=100000")).events;

beforeAll(async () => {
  mkdirSync(project, { recursive: true });
  server = await new CnocServer({
    dataDir: join(root, "data"),
    port: 0,
    openEnrollment: true,
    log: quiet,
    declineBackoffS: 1,
  }).start();
  client = await newClient("alpha").start();
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

test("the host reports its resources, projects and harnesses", async () => {
  const host = (await api("GET", "/v1/hosts")).hosts.find((h) => h.name === "alpha");
  expect(host?.capacity).toEqual({ slots: 4, solo: 1 });
  expect(host?.features).toContain("project/proj");
  expect(host?.features).toContain("harness/shell");
  expect(host?.measured?.cpus).toBeGreaterThan(0);
});

test("a dependency chain runs in order", async () => {
  const [a, b] = [id("first"), id("second")];
  const r = await submit(job(b, "test -f chain.txt", `depends: [${a}]`), job(a, "sleep 0.3; echo hi > chain.txt"));
  expect(r.jobs).toEqual([
    { id: b, state: "blocked", created: true },
    { id: a, state: "queued", created: true },
  ]);
  await reaches(b, "done");
  expect(readFileSync(join(project, "chain.txt"), "utf8")).toBe("hi\n");
  const ev = await events();
  const at = (type: string, jobId: string) => ev.findIndex((e) => e.type === type && e.job === jobId);
  expect(at("job.terminal", a)).toBeLessThan(at("job.ready", b));
  expect(at("job.ready", b)).toBeLessThan(at("attempt.started", b));
});

test("a failing command fails the job and its dependent cannot start", async () => {
  const [a, b] = [id("bad"), id("after-bad")];
  await submit(job(a, "exit 3"), job(b, "true", `depends: [${a}]`));
  const failed = await reaches(a, "failed");
  expect(failed.reason).toBe("stage 1 failed: exit 3");
  const waiting = await until("dependent marked unstartable", async () => {
    const j = await state(b);
    return j.reason ? j : false;
  });
  expect(waiting).toMatchObject({ state: "blocked", reason: `dependency-not-done: ${a}` });
});

test("stages run in order and each reports a result", async () => {
  const j = id("stages");
  await submit(
    job(
      j,
      "",
      "",
      'HARNESS shell\nPROMPT "cnoc progress halfway; cnoc done \\"built it\\""\nPROMPT "test \\"$CNOC_STAGE\\" = 2"',
    ),
  );
  const done = await reaches(j, "done");
  expect(done.result).toEqual([
    { status: "done", summary: "built it" },
    { status: "done", summary: "exit 0" },
  ]);
  const progress = (await events()).find((e) => e.type === "attempt.progress" && e.job === j);
  expect(progress?.data).toEqual({ stage: 1, note: "halfway" });
});

test("a counted resource limits how many run at once", async () => {
  const [a, b] = [id("solo"), id("solo")];
  await submit(job(a, "sleep 0.6", "resources: { solo: 1 }"), job(b, "sleep 0.1", "resources: { solo: 1 }"));
  await reaches(a, "done");
  await reaches(b, "done");
  const ev = await events();
  const ended = ev.findIndex((e) => e.type === "attempt.ended" && e.job === a);
  const started = ev.findIndex((e) => e.type === "attempt.assigned" && e.job === b);
  expect(ended).toBeGreaterThan(-1);
  expect(started).toBeGreaterThan(ended);
});

test("a job no host can run says why", async () => {
  const j = id("nowhere");
  await submit(`---\nid: ${j}\n---\nFROM elsewhere\nHARNESS shell\nPROMPT true\n`);
  const view = await until("pending reason", async () => {
    const v = await state(j);
    return v.pending_reason ? v : false;
  });
  expect(view).toMatchObject({ state: "queued", pending_reason: "no-eligible-host" });
  await api("POST", `/v1/job/cancel?id=${encodeURIComponent(j)}`);
  expect((await state(j)).state).toBe("cancelled");
});

test("cancelling a running job stops its session", async () => {
  const j = id("cancel");
  await submit(job(j, "sleep 60"));
  await reaches(j, "running");
  const attempt = await firstAttempt(j);
  expect(await new Tmux(socket).sessions()).toContain(`cnoc-${attempt}-0`);
  await api("POST", `/v1/job/cancel?id=${encodeURIComponent(j)}`);
  await reaches(j, "cancelled");
  expect(await new Tmux(socket).sessions()).not.toContain(`cnoc-${attempt}-0`);
  expect(existsSync(join(root, "state-alpha", "logs", `${attempt}-1.log`))).toBe(true);
});

test("the time limit ends a job that runs too long", async () => {
  const j = id("slow");
  await submit(job(j, "sleep 60", "time: 1s"));
  expect((await reaches(j, "failed")).reason).toBe("timeout");
});

test("a job can submit a follow-up job through the client without credentials", async () => {
  const [parent, child] = [id("planner"), id("planned")];
  writeFileSync(join(project, "child.job"), job(child, "echo planned > planned.txt"));
  await submit(job(parent, "env -u CNOC_URL cnoc submit child.job"));
  await reaches(parent, "done");
  await reaches(child, "done");
  expect(existsSync(join(project, "planned.txt"))).toBe(true);
  const submitted = (await events()).find((e) => e.type === "job.submitted" && e.job === child);
  expect(submitted?.actor).toBe("host:alpha");
});

test("a restarted client picks its running session back up", async () => {
  const j = id("survivor");
  await submit(job(j, "sleep 2; cnoc done survived"));
  await reaches(j, "running");
  await client.stop();
  await until("alpha offline", async () =>
    (await api("GET", "/v1/hosts")).hosts.find((h) => h.name === "alpha" && !h.online),
  );
  expect((await state(j)).state).toBe("running");
  client = await newClient("alpha").start();
  const done = await reaches(j, "done");
  expect(done.result).toEqual([{ status: "done", summary: "survived" }]);
});

test("work finished while the server was down is reported when it returns", async () => {
  const dir = join(root, "data-restart");
  let srv = await new CnocServer({ dataDir: dir, port: 0, openEnrollment: true, log: quiet }).start();
  const port = srv.port;
  const beta = await new CnocClient({
    config: { server: srv.url, name: "beta", projects: { proj: project } },
    stateDir: join(root, "state-beta"),
    tmuxSocket: socket,
    pollMs: 100,
    log: quiet,
    checkout: noCheckout,
  }).start();
  try {
    const j = id("outlives-server");
    const queued = id("waits-for-server");
    await api(
      "POST",
      "/v1/jobs",
      { jobs: [job(j, "sleep 1.5; cnoc done finished-offline"), job(queued, "true", `depends: [${j}]`)] },
      srv,
    );
    await reaches(j, "running", srv);
    await srv.stop();
    await until("the session to finish with no server", () => beta.running.length === 0, 10_000);
    srv = await new CnocServer({ dataDir: dir, port, openEnrollment: true, log: quiet }).start();
    const done = await reaches(j, "done", srv);
    expect(done.result).toEqual([{ status: "done", summary: "finished-offline" }]);
    // And the queue moves again once the server is back.
    await reaches(queued, "done", srv);
  } finally {
    await beta.stop();
    await srv.stop();
  }
});

test("a host that lost a session while away is reconciled", async () => {
  const j = id("vanished");
  await submit(job(j, "sleep 60"));
  await reaches(j, "running");
  const attempt = await firstAttempt(j);
  await client.stop();
  await new Tmux(socket).kill(`cnoc-${attempt}-0`);
  client = await newClient("alpha").start();
  expect((await reaches(j, "failed")).reason).toBe("no-result (session-lost)");
});

test("an unknown host waits for approval", async () => {
  const strict = await new CnocServer({ dataDir: join(root, "data-strict"), port: 0, log: quiet }).start();
  const gamma = await new CnocClient({
    config: { server: strict.url, name: "gamma", projects: {} },
    stateDir: join(root, "state-gamma"),
    tmuxSocket: socket,
    log: quiet,
    checkout: noCheckout,
  }).start();
  try {
    const hosts = async () => (await api("GET", "/v1/hosts", undefined, strict)).hosts;
    const pending = await until("gamma pending", async () => (await hosts()).find((h) => h.name === "gamma"));
    expect(pending).toMatchObject({ status: "pending", online: false });
    expect((await api("POST", "/v1/host/approve?name=gamma", undefined, strict)).host.status).toBe("approved");
    await until("gamma online", async () => (await hosts()).find((h) => h.name === "gamma" && h.online), 20_000);
  } finally {
    await gamma.stop();
    await strict.stop();
  }
});

test("a client on the wrong version updates itself and takes no work", async () => {
  const marker = join(root, "updated.txt");
  let exitCode = -1;
  const old = newClient(
    "delta",
    { update: `echo "$CNOC_TARGET_VERSION" > ${marker}` },
    {
      version: "0.0.1-old",
      exit: (c) => {
        exitCode = c;
      },
    },
  );
  await old.start();
  await until("update command to run and the client to exit", () => exitCode !== -1);
  expect(exitCode).toBe(75);
  expect(readFileSync(marker, "utf8").trim()).toBe(server.version);
  // The server knows the host by its signed hello, shows what it runs, and gave it nothing.
  const delta = (await api("GET", "/v1/hosts")).hosts.find((h) => h.name === "delta");
  expect(delta).toMatchObject({ online: false, running: [], mismatch: { version: "0.0.1-old" } });
  expect(delta?.mismatch?.note).toMatch(/^updating to /);
});

test("a second client cannot share a state directory", async () => {
  await expect(newClient("alpha").start()).rejects.toThrow(/already using/);
  // The refused start must not have disturbed the first client.
  const j = id("still-fine");
  await submit(job(j, "true"));
  await reaches(j, "done");
});

test("a webhook subscriber receives signed events in order", async () => {
  const got: Array<{ seq: number; type: string; job: string; sig: string; body: string }> = [];
  let failFirst = true;
  const hook = Bun.serve({
    port: 0,
    fetch: async (req) => {
      if (failFirst) {
        failFirst = false;
        return new Response("try again", { status: 500 });
      }
      const body = await req.text();
      got.push({ ...JSON.parse(body), sig: req.headers.get("x-cnoc-signature") ?? "", body });
      return new Response("ok");
    },
  });
  try {
    const sub = (
      await api("POST", "/v1/subscriptions", {
        url: `http://127.0.0.1:${hook.port}/`,
        types: ["job.submitted", "job.terminal"],
        secret: "s3cret",
      })
    ).subscription;
    const j = id("hooked");
    await submit(job(j, "true"));
    await until("both deliveries", () => got.filter((e) => e.job === j).length === 2);
    const mine = got.filter((e) => e.job === j);
    expect(mine.map((e) => e.type)).toEqual(["job.submitted", "job.terminal"]);
    const [first, second] = mine;
    if (!first || !second) throw new Error("expected two deliveries");
    expect(first.seq).toBeLessThan(second.seq);
    const hmac = new Bun.CryptoHasher("sha256", "s3cret").update(first.body).digest("hex");
    expect(first.sig).toBe(`sha256=${hmac}`);
    await api("DELETE", `/v1/subscriptions?id=${sub.id}`);
  } finally {
    await hook.stop(true);
  }
});

test("the event stream replays from a sequence number and then follows", async () => {
  const from = (await api("GET", "/v1/jobs")).as_of;
  const ctl = new AbortController();
  const res = await fetch(`${server.url}/v1/events/stream?after=${from}`, {
    headers: { authorization: `Bearer ${server.adminToken}` },
    signal: ctl.signal,
  });
  const j = id("streamed");
  await submit(job(j, "true"));
  const reader = res.body?.getReader();
  if (!reader) throw new Error("the stream has no body");
  let text = "";
  await until("terminal event on the stream", async () => {
    const { value } = await reader.read();
    text += new TextDecoder().decode(value);
    return text.includes("event: job.terminal");
  });
  ctl.abort();
  const seqs = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
  expect(seqs[0]).toBe(from + 1);
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  expect(text).toContain(`"job":"${j}"`);
});

test("a drained host takes no new work until it is undrained", async () => {
  await api("POST", "/v1/host/drain?name=alpha&on=1");
  const j = id("drained");
  await submit(job(j, "true"));
  const waiting = await until("pending reason", async () => {
    const v = await state(j);
    return v.pending_reason ? v : false;
  });
  expect(waiting).toMatchObject({ state: "queued", pending_reason: "no-eligible-host" });
  await api("POST", "/v1/host/drain?name=alpha&on=0");
  await reaches(j, "done");
});

test("a failed job can be requeued and run again", async () => {
  const j = id("retry");
  const flag = join(project, `flag-${seq}`);
  await submit(job(j, `test -f ${flag}`));
  await reaches(j, "failed");
  writeFileSync(flag, "");
  expect((await api("POST", `/v1/job/requeue?id=${encodeURIComponent(j)}`)).job.state).toBe("queued");
  await reaches(j, "done");
  expect((await api("GET", `/v1/job?id=${encodeURIComponent(j)}`)).attempts.length).toBe(2);
});

test("a job on an unreachable host can be abandoned, and the host is told to stop it when it returns", async () => {
  const j = id("abandoned");
  await submit(job(j, "sleep 60"));
  await reaches(j, "running");
  const attempt = await firstAttempt(j);
  expect((await api("POST", `/v1/job/abandon?id=${encodeURIComponent(j)}`)).status).toBe(409);
  await client.stop();
  await until("alpha offline", async () =>
    (await api("GET", "/v1/hosts")).hosts.find((h) => h.name === "alpha" && !h.online),
  );
  expect((await api("POST", `/v1/job/abandon?id=${encodeURIComponent(j)}`)).job).toMatchObject({
    state: "failed",
    reason: "abandoned",
  });
  client = await newClient("alpha").start();
  await until(
    "the orphaned session to be stopped",
    async () => !(await new Tmux(socket).sessions()).includes(`cnoc-${attempt}-0`),
  );
  expect((await state(j)).state).toBe("failed");
});

test("a custom placement policy is loaded from a file", async () => {
  const file = join(root, "policy.ts");
  writeFileSync(file, 'export default { filter: (job) => (job.id.includes("banned") ? "policy says no" : null) };\n');
  const srv = await new CnocServer({
    dataDir: join(root, "data-policy"),
    port: 0,
    openEnrollment: true,
    log: quiet,
    policy: file,
  }).start();
  const eps = await new CnocClient({
    config: { server: srv.url, name: "eps", projects: { proj: project } },
    stateDir: join(root, "state-eps"),
    tmuxSocket: socket,
    pollMs: 100,
    log: quiet,
    checkout: noCheckout,
  }).start();
  try {
    const [ok, banned] = [id("allowed"), id("banned")];
    await api("POST", "/v1/jobs", { jobs: [job(banned, "true"), job(ok, "true")] }, srv);
    await reaches(ok, "done", srv);
    expect(await state(banned, srv)).toMatchObject({ state: "queued", pending_reason: "resources" });
  } finally {
    await eps.stop();
    await srv.stop();
  }
});

test("requests without a valid token are refused", async () => {
  const res = await fetch(`${server.url}/v1/jobs`, { headers: { authorization: "Bearer nope" } });
  expect(res.status).toBe(401);
  expect((await fetch(`${server.url}/v1/health`)).status).toBe(200);
});

test("a template runs again and again, with arguments, pinned to a host", async () => {
  const name = `tpl-${++seq}`;
  const text = `---\nid: ${name}\n---\nARG WORD\nARG FILE=tpl.txt\nFROM proj\nHARNESS shell\nPROMPT "echo \${WORD} >> \${FILE}; cnoc done \\"wrote \${WORD} as $USER\\""\n`;
  const pin = await newClient("pin", { features: ["host/alpha"] }).start();
  try {
    await until("pin online", async () =>
      (await api("GET", "/v1/hosts")).hosts.find((h) => h.name === "pin" && h.online),
    );
    // A host cannot claim to be another one.
    const hosts = (await api("GET", "/v1/hosts")).hosts;
    expect(hosts.find((h) => h.name === "pin")?.features.filter((f: string) => f.startsWith("host/"))).toEqual([
      "host/pin",
    ]);

    const added = await api("POST", "/v1/templates", { text, source: "/somewhere/tpl.job" });
    expect(added).toMatchObject({
      status: 200,
      result: "added",
      template: {
        name,
        args: [
          { name: "WORD", default: null },
          { name: "FILE", default: "tpl.txt" },
        ],
      },
    });
    expect((await api("GET", "/v1/templates")).templates.map((t) => t.name)).toContain(name);

    const runs = [];
    for (const word of ["one", "two", "three"])
      runs.push(
        await api("POST", `/v1/template/run?ref=${added.template.id}`, {
          set: { WORD: word },
          overrides: { on: "pin" },
        }),
      );
    expect(runs.map((r) => r.job.id)).toEqual([`${name}/1`, `${name}/2`, `${name}/3`]);
    for (const r of runs) {
      const done = await reaches(r.job.id, "done");
      expect(done.requires).toEqual(["host/pin"]);
      expect(done.labels).toEqual({ template: name });
    }
    const ev = await events();
    expect(ev.filter((e) => e.type === "attempt.started" && e.job?.startsWith(`${name}/`)).map((e) => e.host)).toEqual([
      "pin",
      "pin",
      "pin",
    ]);
    expect(readFileSync(join(project, "tpl.txt"), "utf8").split("\n").filter(Boolean).sort()).toEqual([
      "one",
      "three",
      "two",
    ]);
    expect((await state(`${name}/1`)).result?.[0]?.summary).toMatch(/^wrote one as \S+$/);

    expect((await api("POST", `/v1/template/run?ref=${name}`, { set: {} })).error).toMatch(/WORD has no default/);
    expect(
      (await api("POST", `/v1/template/run?ref=${name}`, { set: { WORD: "x" }, overrides: { on: "nowhere" } })).status,
    ).toBe(404);
    expect(
      (await api("DELETE", `/v1/template?ref=tpl.job&path=${encodeURIComponent("/somewhere/tpl.job")}`)).template.name,
    ).toBe(name);
    expect((await api("GET", `/v1/template?ref=${name}`)).status).toBe(404);
  } finally {
    await pin.stop();
  }
});

test("a keyed template run happens once, however often it is offered", async () => {
  const name = `keyed-${++seq}`;
  const text = `---\nid: ${name}\nkey: issue-\${ISSUE}\n---\nARG ISSUE\nARG CMD=true\nFROM proj\nHARNESS shell\nPROMPT "\${CMD}"\n`;
  expect((await api("POST", "/v1/templates", { text })).status).toBe(200);
  const runOf = (body: unknown) => api("POST", `/v1/template/run?ref=${name}`, body);

  // The template's own key names the run; it fails, and offering it again does not start it again.
  const first = await runOf({ set: { ISSUE: "7", CMD: "false" }, keyed: true });
  expect(first).toMatchObject({ status: 200, created: true, job: { id: `${name}/issue-7` } });
  expect(first.state).toBe(first.job.state);
  await reaches(`${name}/issue-7`, "failed");
  const again = {
    status: 200,
    created: false,
    state: "failed",
    job: { id: `${name}/issue-7`, state: "failed" },
  };
  // Other arguments, and then a template that now needs an argument this caller does not send.
  expect(await runOf({ set: { ISSUE: "7", CMD: "echo other" }, keyed: true })).toMatchObject(again);
  const changed = text.replace("ARG CMD=true\n", "ARG CMD=true\nARG NEW\n");
  expect((await api("POST", "/v1/templates", { text: changed })).result).toBe("updated");
  expect(await runOf({ set: { ISSUE: "7", CMD: "false" }, keyed: true, key: null })).toMatchObject(again);
  expect((await runOf({ set: { ISSUE: "70" } })).error).toMatch(/NEW has no default/);
  expect((await api("POST", "/v1/templates", { text })).result).toBe("updated");

  // A key given with the run overrides the template's, and may contain a slash.
  const own = await runOf({ set: { ISSUE: "8" }, key: "myapp/8" });
  expect(own).toMatchObject({ created: true, job: { id: `${name}/myapp/8` } });
  await reaches(`${name}/myapp/8`, "done");
  expect(await runOf({ set: { ISSUE: "9" }, key: "myapp/8" })).toMatchObject({ created: false, state: "done" });
  expect((await runOf({ set: { ISSUE: "1" }, key: "a b" })).error).toMatch(/not a valid id segment/);
  expect((await runOf({ set: { ISSUE: "1" }, key: 5 })).error).toMatch(/key must be a string/);
  expect((await runOf({ set: { ISSUE: "1" }, key: "8" })).error).toMatch(/all digits/);
  // A job this template did not start is not passed off as a run of it.
  await submit(job(`${name}/plain`, "true"));
  const taken = await runOf({ set: { ISSUE: "1" }, key: "plain" });
  expect(taken).toMatchObject({
    status: 409,
    error: `job ${name}/plain exists and was not started by template ${name}`,
  });
  await reaches(`${name}/plain`, "done");

  const runs = (await events()).flatMap((e) =>
    e.type === "template.run" && (e.data as { name: string }).name === name ? [e.job] : [],
  );
  expect(runs).toEqual([`${name}/issue-7`, `${name}/myapp/8`]);
  expect((await api("GET", `/v1/template?ref=${name}`)).template.runs).toBe(2);

  // A template without a key: keyed refuses the run, and no job is made.
  const loose = `loose-${++seq}`;
  await api("POST", "/v1/templates", { text: `---\nid: ${loose}\n---\nFROM proj\nHARNESS shell\nPROMPT true\n` });
  const refused = await api("POST", `/v1/template/run?ref=${loose}`, { keyed: true });
  expect(refused.status).toBe(400);
  expect(refused.error).toMatch(/this run has no key/);
  expect((await api("GET", "/v1/jobs?all=1")).jobs.some((j) => j.id.startsWith(`${loose}/`))).toBe(false);
  const numbered = await api("POST", `/v1/template/run?ref=${loose}`, {});
  expect(numbered).toMatchObject({ created: true, job: { id: `${loose}/1` } });
  await reaches(`${loose}/1`, "done");
});

test("a job with a begin time waits for it", async () => {
  const j = id("later");
  const r = await api("POST", "/v1/jobs", { jobs: [job(j, "true")], overrides: { begin: "+3s" } });
  const submitted = Date.now();
  expect(r.jobs[0]).toMatchObject({ id: j, state: "queued" });
  const waiting = await until("the job to be listed as scheduled", async () => {
    const s = await state(j);
    return s.pending_reason === "scheduled" ? s : false;
  });
  expect(waiting.begin_at ?? 0).toBeGreaterThan(submitted + 2000);
  await reaches(j, "done");
  const started = (await events()).find((e) => e.type === "attempt.started" && e.job === j);
  expect(started?.ts).toBeGreaterThanOrEqual(waiting.begin_at ?? Number.POSITIVE_INFINITY);
});

test("raising a queued job's priority moves it ahead; a running job is not interrupted", async () => {
  const [holder, plain, urgent] = [id("holder"), id("plain"), id("urgent")];
  const solo = "resources: { solo: 1 }";
  await submit(job(holder, "sleep 1.5", solo));
  await reaches(holder, "running");
  await submit(job(plain, "true", solo));
  await submit(job(urgent, "true", solo));
  expect((await api("POST", `/v1/job/priority?id=${encodeURIComponent(urgent)}&value=5`)).job.priority).toBe(5);
  expect((await api("POST", `/v1/job/priority?id=${encodeURIComponent(holder)}&value=9`)).status).toBe(409);
  await reaches(plain, "done");
  await reaches(urgent, "done");
  const ev = await events();
  const startedAt = (jobId: string) => ev.findIndex((e) => e.type === "attempt.started" && e.job === jobId);
  expect(startedAt(holder)).toBeLessThan(startedAt(urgent));
  expect(startedAt(urgent)).toBeLessThan(startedAt(plain));
  expect(ev.find((e) => e.type === "job.terminal" && e.job === holder)?.data).toMatchObject({ state: "done" });
});
