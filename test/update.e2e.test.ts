/**
 * End to end for updates: a server restarting on a new commit, clients that cannot reach it, and
 * what a host on another version may say to the server. Real servers, real clients, real tmux
 * sessions with the shell harness, and throwaway git repositories (test/git-fixture.ts).
 */
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { type KeyObject, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { specTempDir } from "../scripts/testkit";
import { CnocClient } from "../src/client/client";
import { Tmux } from "../src/client/tmux";
import { PROTOCOL } from "../src/protocol";
import { CnocServer, type HostInfo, type JobInfo } from "../src/server/server";
import type { AttemptRow } from "../src/server/store";
import { versionOf } from "../src/version";
import { commit, git, makeRepos } from "./git-fixture";

// Each test starts real servers and tmux sessions and waits for them to agree, so one legitimately
// takes seconds. Each wait inside a test polls a condition (see `until`).
const E2E_TEST_TIMEOUT_MS = 40_000;
setDefaultTimeout(E2E_TEST_TIMEOUT_MS);
/** How often `until` looks again. */
const POLL_MS = 50;
/** How long `until` waits for a condition by default. */
const UNTIL_MS = 15_000;

const root = specTempDir("cnoc-update-e2e-");
const project = join(root, "proj");
mkdirSync(project, { recursive: true });
// Not the socket the other end-to-end files use: they can run in one process.
const socket = `cnoc-test-update-${process.pid}`;
const quiet = () => {};
let seq = 0;

interface Res {
  status: number;
  job: JobInfo;
  attempts: AttemptRow[];
  hosts: HostInfo[];
}

async function api(method: string, path: string, body: unknown, srv: CnocServer): Promise<Res> {
  const res = await fetch(`${srv.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${srv.adminToken}`, "content-type": "application/json" },
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
const job = (jobId: string, cmd: string) =>
  `---\nid: ${jobId}\n---\nFROM proj\nHARNESS shell\nPROMPT ${JSON.stringify(cmd)}\n`;
const reaches = (jobId: string, want: string, srv: CnocServer) =>
  until(`${jobId} to be ${want}`, async () => {
    const j = (await api("GET", `/v1/job?id=${encodeURIComponent(jobId)}`, undefined, srv)).job;
    return j?.state === want ? j : false;
  });

afterAll(async () => {
  await new Tmux(socket).killServer();
  // tmux leaves its socket file behind when the server is told to exit; it is outside the test's temp directory.
  rmSync(join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${process.getuid?.() ?? 0}`, socket), { force: true });
});

test("a server restarted on a new commit brings its client to it, and the session keeps running", async () => {
  const { clone, commits } = makeRepos(specTempDir("cnoc-e2e-upgrade-"), 3);
  // The server moves to the middle commit while main has already moved past it.
  const [from, to] = commits as [string, string, string];
  const dir = join(root, "data-upgrade");
  let srv = await new CnocServer({ dataDir: dir, port: 0, openEnrollment: true, log: quiet, version: from }).start();
  const port = srv.port;
  const exits: number[] = [];
  // What the service manager runs: the code in the checkout, whatever version that is now.
  const service = () =>
    new CnocClient({
      config: { server: srv.url, name: "zeta", projects: { proj: project } },
      stateDir: join(root, "state-zeta"),
      tmuxSocket: socket,
      pollMs: 100,
      log: quiet,
      checkout: clone,
      version: versionOf(clone),
      exit: (c) => exits.push(c),
    });
  let zeta = await service().start();
  try {
    const j = id("across-upgrade");
    const go = `go-${seq}.txt`;
    await api(
      "POST",
      "/v1/jobs",
      { jobs: [job(j, `until [ -f ${go} ]; do sleep 0.1; done; cnoc done upgraded`)] },
      srv,
    );
    await reaches(j, "running", srv);
    const attempt = (await api("GET", `/v1/job?id=${encodeURIComponent(j)}`, undefined, srv)).attempts[0]?.id;

    await srv.stop();
    srv = await new CnocServer({ dataDir: dir, port, openEnrollment: true, log: quiet, version: to }).start();
    await until("the client to update and exit", () => exits.length > 0);
    expect(exits).toEqual([75]);
    expect(git(clone, "rev-parse", "HEAD")).toBe(to);
    expect(await new Tmux(socket).sessions()).toContain(`cnoc-${attempt}-0`);
    const outdated = (await api("GET", "/v1/hosts", undefined, srv)).hosts.find((h) => h.name === "zeta");
    expect(outdated?.mismatch).toMatchObject({ version: from, note: `updating to ${to.slice(0, 7)}` });

    zeta = await service().start();
    const back = await until("zeta back on the new version", async () =>
      (await api("GET", "/v1/hosts", undefined, srv)).hosts.find((h) => h.name === "zeta" && h.online),
    );
    expect(back).toMatchObject({ version: to, mismatch: null });
    writeFileSync(join(project, go), "");
    expect((await reaches(j, "done", srv)).result).toEqual([{ status: "done", summary: "upgraded" }]);
  } finally {
    await zeta.stop();
    await srv.stop();
  }
});

test("a client that cannot reach the server's commit says why and does not restart", async () => {
  const { origin, clone } = makeRepos(specTempDir("cnoc-e2e-unpushed-"), 1);
  const elsewhere = join(origin, "..", "dev");
  git(join(origin, ".."), "clone", "-q", origin, elsewhere);
  const unpushed = commit(elsewhere, "code.txt", "never pushed\n");
  const srv = await new CnocServer({
    dataDir: join(root, "data-unpushed"),
    port: 0,
    openEnrollment: true,
    log: quiet,
    version: unpushed,
  }).start();
  const exits: number[] = [];
  const eta = await new CnocClient({
    config: { server: srv.url, name: "eta", projects: { proj: project } },
    stateDir: join(root, "state-eta"),
    tmuxSocket: socket,
    pollMs: 100,
    log: quiet,
    checkout: clone,
    version: versionOf(clone),
    exit: (c) => exits.push(c),
  }).start();
  try {
    const host = await until("the failure to reach the server", async () => {
      const h = (await api("GET", "/v1/hosts", undefined, srv)).hosts.find((x) => x.name === "eta");
      return h?.mismatch?.note?.includes("failed") ? h : null;
    });
    expect(host.online).toBe(false);
    expect(host.mismatch?.note).toMatch(
      /^update to \w{7} failed \(try 1\): commit \w{7} is not on origin; was it pushed\?; next try in \d+s$/,
    );
    expect(exits).toEqual([]);
  } finally {
    await eta.stop();
    await srv.stop();
  }
});

/** One hand-made hello, as any key holder could send it. Resolves when the server closes the connection. */
async function rawHello(srv: CnocServer, name: string, key: KeyObject, fields: { version: string; update: string }) {
  const ws = new WebSocket(`${srv.url.replace(/^http/, "ws")}/v1/client`);
  const closed = new Promise<void>((resolve) => {
    ws.onclose = () => resolve();
  });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data)) as { t: string; nonce?: string };
    if (msg.t !== "challenge") return;
    const pubkey = createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64");
    const sig = sign(null, Buffer.from(`cnoc-hello\n${name}\n${msg.nonce}`), key).toString("base64");
    ws.send(JSON.stringify({ t: "hello", name, pubkey, sig, protocol: PROTOCOL, ...fields }));
  };
  await closed;
}

test("what a host on another version says is shown only for an approved key, and only as plain text", async () => {
  const strict = await new CnocServer({ dataDir: join(root, "data-notes"), port: 0, log: quiet }).start();
  try {
    const { privateKey } = generateKeyPairSync("ed25519");
    const forged = { version: "\u001b[2Jevil", update: "\u001b[31mfine\nmallory online all good\u0007" };
    await rawHello(strict, "theta", privateKey, forged);
    const pending = (await api("GET", "/v1/hosts", undefined, strict)).hosts.find((h) => h.name === "theta");
    expect(pending).toMatchObject({ status: "pending", mismatch: null });

    await api("POST", "/v1/host/approve?name=theta", undefined, strict);
    await rawHello(strict, "theta", privateKey, forged);
    const shown = (await api("GET", "/v1/hosts", undefined, strict)).hosts.find((h) => h.name === "theta");
    expect(shown?.mismatch).toMatchObject({ version: "(invalid)", note: " [31mfine mallory online all good " });
  } finally {
    await strict.stop();
  }
});
