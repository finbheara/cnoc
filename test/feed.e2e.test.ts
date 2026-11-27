/**
 * End to end for `cnoc feed`: the real CLI as its own process, against a real server. No host is
 * connected, so the jobs it creates stay queued; what is tested is which jobs exist.
 */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { specTempDir } from "../scripts/testkit";
import { CnocServer } from "../src/server/server";

// Each test starts the CLI several times, and each start is a fresh bun process.
const FEED_E2E_TEST_TIMEOUT_MS = 30_000;
setDefaultTimeout(FEED_E2E_TEST_TIMEOUT_MS);

const root = specTempDir("cnoc-feed-e2e-");
const quiet = () => {};
let server: CnocServer;
let seq = 0;

beforeAll(async () => {
  server = await new CnocServer({ dataDir: join(root, "data"), port: 0, log: quiet }).start();
});
afterAll(async () => {
  await server.stop();
});

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; template: { runs: number } }> {
  const res = await fetch(`${server.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${server.adminToken}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, ...((await res.json()) as { template: { runs: number } }) };
}
const jobStatus = async (id: string) => (await api("GET", `/v1/job?id=${encodeURIComponent(id)}`)).status;

/** Starts `cnoc feed` as its own process against the test server, never the one in the CLI config. */
function startFeed(args: string[], to: { url: string; token: string } = { url: server.url, token: server.adminToken }) {
  const env: Record<string, string | undefined> = { ...process.env, CNOC_URL: to.url, CNOC_TOKEN: to.token };
  env.CNOC_SOCK = undefined;
  const p = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "feed", ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const lines = (s: string) => s.split("\n").filter(Boolean);
  const done = Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]).then(
    ([out, err, code]) => ({ out: lines(out), err: lines(err), code }),
  );
  return { proc: p, done };
}
const feedCli = (...args: string[]) => startFeed(args).done;

/** Adds a template with PROJECT and ISSUE and returns its name. */
async function template(front = ""): Promise<string> {
  const name = `feed-${++seq}`;
  const text = `---\nid: ${name}\n${front}---\nARG PROJECT\nARG ISSUE\nFROM proj\nHARNESS shell\nPROMPT "true"\n`;
  expect((await api("POST", "/v1/templates", { text })).status).toBe(200);
  return name;
}
const created = (id: string) =>
  expect.stringMatching(new RegExp(`^\\[feed\\] created ${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(queued\\)$`));

test("a feeder turns a backlog into keyed jobs, each item once, at most --max a pass", async () => {
  const name = await template("key: ${PROJECT}-${ISSUE}\n");
  const backlog = join(root, `${name}.jsonl`);
  const items = (...issues: string[]) =>
    writeFileSync(
      backlog,
      issues.map((i) => `${JSON.stringify({ template: name, set: { PROJECT: "myapp", ISSUE: i } })}\n`).join(""),
    );

  items("1", "2");
  expect(await feedCli("--", "cat", backlog)).toEqual({
    out: [
      created(`${name}/myapp-1`),
      created(`${name}/myapp-2`),
      "[feed] pass: 2 created, 0 already there, 0 rejected",
    ],
    err: [],
    code: 0,
  });
  expect(await feedCli("--", "cat", backlog)).toEqual({
    out: ["[feed] pass: 0 created, 2 already there, 0 rejected"],
    err: [],
    code: 0,
  });

  items("1", "2", "3");
  expect((await feedCli("--", "cat", backlog)).out).toEqual([
    created(`${name}/myapp-3`),
    "[feed] pass: 1 created, 2 already there, 0 rejected",
  ]);

  items("1", "2", "3", "4", "5", "6");
  expect((await feedCli("--max", "2", "--", "cat", backlog)).out).toEqual([
    created(`${name}/myapp-4`),
    created(`${name}/myapp-5`),
    "[feed] pass: 2 created, 3 already there, 0 rejected, 1 held back by --max 2",
  ]);
  expect((await feedCli("--max", "2", "--", "cat", backlog)).out).toEqual([
    created(`${name}/myapp-6`),
    "[feed] pass: 1 created, 5 already there, 0 rejected",
  ]);

  // A key on the line overrides the template's.
  writeFileSync(
    backlog,
    `${JSON.stringify({ template: name, key: "hotfix", set: { PROJECT: "myapp", ISSUE: "1" } })}\n`,
  );
  expect((await feedCli("--", "cat", backlog)).out).toEqual([
    created(`${name}/hotfix`),
    "[feed] pass: 1 created, 0 already there, 0 rejected",
  ]);

  for (const i of ["1", "2", "3", "4", "5", "6"]) expect(await jobStatus(`${name}/myapp-${i}`)).toBe(200);
  expect(await jobStatus(`${name}/1`)).toBe(404);
  expect((await api("GET", `/v1/template?ref=${name}`)).template.runs).toBe(7);
});

test("a feeder reports bad lines and refused runs, submits the rest, and submits nothing if its command fails", async () => {
  const name = await template();
  // A job by an id the template would use, which the template did not start.
  const clash = `---\nid: ${name}/clash\n---\nFROM proj\nHARNESS shell\nPROMPT "true"\n`;
  expect((await api("POST", "/v1/jobs", { jobs: [clash] })).status).toBe(200);
  const backlog = join(root, `${name}.jsonl`);
  const run = (o: object) => JSON.stringify({ template: name, set: { PROJECT: "myapp", ISSUE: "1" }, ...o });
  writeFileSync(
    backlog,
    [
      run({ key: "a" }),
      "not json",
      run({}),
      run({ template: "no-such-template", key: "b" }),
      run({ key: "42" }),
      run({ key: "clash" }),
      run({ key: null, set: { PROJECT: "myapp", ISSUE: "2" } }),
      run({ key: "c" }),
    ].join("\n"),
  );
  const r = await feedCli("--", "cat", backlog);
  expect(r).toEqual({
    out: [created(`${name}/a`), created(`${name}/c`), "[feed] pass: 2 created, 0 already there, 6 rejected"],
    err: [
      expect.stringMatching(/^\[feed\] line 2 rejected: not JSON/),
      expect.stringMatching(/^\[feed\] line 3 rejected by the server: .*key/),
      "[feed] line 4 rejected by the server: no such template: no-such-template",
      expect.stringMatching(/^\[feed\] line 5 rejected by the server: .*digits/),
      `[feed] line 6 rejected by the server: job ${name}/clash exists and was not started by template ${name}`,
      expect.stringMatching(/^\[feed\] line 7 rejected by the server: .*key/),
    ],
    code: 1,
  });
  for (const id of [`${name}/a`, `${name}/c`]) expect(await jobStatus(id)).toBe(200);
  expect(await jobStatus(`${name}/42`)).toBe(404);

  writeFileSync(backlog, `${run({ key: "d" })}\n`);
  expect(await feedCli("--", "sh", "-c", 'cat "$0"; exit 4', backlog)).toEqual({
    out: [],
    err: ["[feed] command exited with status 4; nothing submitted this pass"],
    code: 1,
  });
  expect(await jobStatus(`${name}/d`)).toBe(404);
});

/** A stand-in server. `run` answers the template run route; every request is counted. */
function stub(health: object, run: (req: Request) => Promise<Response> | Response) {
  const seen: string[] = [];
  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      seen.push(`${req.method} ${path}`);
      return path === "/v1/health" ? Response.json(health) : run(req);
    },
  });
  return { url: `http://127.0.0.1:${srv.port}`, seen, stop: () => srv.stop(true) };
}

test("against a server without keyed runs, starting the feeder again and again creates nothing", async () => {
  // The server before keyed runs: the same health answer except for features, and a run route that
  // would make a numbered job of every request.
  let made = 0;
  const old = stub({ ok: true, version: "0.1.0", protocol: 1 }, () =>
    Response.json({ job: { id: `free/${++made}`, state: "queued" } }),
  );
  try {
    const backlog = join(root, "old.jsonl");
    writeFileSync(backlog, `${JSON.stringify({ template: "free", key: "a" })}\n`);
    for (const args of [
      ["--", "cat", backlog],
      ["--every", "1s", "--", "cat", backlog],
      ["--", "cat", backlog],
    ]) {
      const r = await startFeed(args, { url: old.url, token: "t" }).done;
      expect(r.code).toBe(78);
      expect(r.err.at(-1)).toMatch(/does not do keyed template runs.*\(exit 78\)$/);
    }
    expect(made).toBe(0);
    expect(old.seen).toEqual(["GET /v1/health", "GET /v1/health", "GET /v1/health"]);
  } finally {
    old.stop();
  }
});

test("a wrong token ends the feeder with 78, even with --every", async () => {
  const name = await template("key: ${PROJECT}-${ISSUE}\n");
  const backlog = join(root, `${name}.jsonl`);
  writeFileSync(backlog, `${JSON.stringify({ template: name, set: { PROJECT: "myapp", ISSUE: "1" } })}\n`);
  const r = await startFeed(["--every", "1s", "--", "cat", backlog], { url: server.url, token: "wrong" }).done;
  expect(r.code).toBe(78);
  expect(r.err.at(-1)).toMatch(/^\[feed\] the server refused the token \(401\).*not retrying \(exit 78\)$/);
  expect(await jobStatus(`${name}/myapp-1`)).toBe(404);
});

test("SIGTERM during submission to a server that never answers ends the feeder promptly", async () => {
  let arrived: () => void = () => {};
  const inFlight = new Promise<void>((done) => {
    arrived = done;
  });
  const silent = stub({ ok: true, features: ["keyed-runs"] }, () => {
    arrived();
    return new Promise<Response>(() => {});
  });
  try {
    const backlog = join(root, "silent.jsonl");
    writeFileSync(backlog, ["a", "b", "c"].map((key) => `${JSON.stringify({ template: "t", key })}\n`).join(""));
    const feeder = startFeed(["--every", "1h", "--", "cat", backlog], { url: silent.url, token: "t" });
    await inFlight;
    feeder.proc.kill("SIGTERM");
    const r = await feeder.done;
    expect(r.code).toBe(0);
    expect(r.err).toEqual([
      "[feed] SIGTERM: stopping; send it again to exit at once",
      "[feed] line 1: the request for t key a was cut off (stopped); its job may have been created",
      "[feed] pass stopped at line 1: stopped",
      "[feed] pass: 0 created, 0 already there, 0 rejected (stopped early)",
    ]);
    expect(silent.seen).toEqual(["GET /v1/health", "POST /v1/template/run"]);
  } finally {
    silent.stop();
  }
});
