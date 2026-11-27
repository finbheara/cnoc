import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { specTempDir } from "../scripts/testkit";
import { SOURCE_LIMITS, runSource } from "../src/feed-source";

/** Long enough for `sh` to start and print; each slow source below would take far longer. */
const SHORT_SOURCE_TIMEOUT_MS = 500;
/** How often to look again for a file the command writes. */
const POLL_MS = 10;
const short = { ...SOURCE_LIMITS, timeoutMs: SHORT_SOURCE_TIMEOUT_MS };

const dir = specTempDir("cnoc-feed-source-");
let n = 0;
const pidFile = () => join(dir, `pid-${++n}`);
/** Whether `pid` is a live process; a zombie waiting to be reaped is not. */
const alive = (pid: number): boolean => {
  const ps = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]);
  const stat = ps.stdout.toString().trim();
  return ps.exitCode === 0 && stat !== "" && !stat.startsWith("Z");
};
/** Processes a test started outside any group the feeder can reach; stopped when the file ends. */
const escaped: number[] = [];
afterAll(() => {
  for (const pid of escaped) if (alive(pid)) process.kill(pid, "SIGTERM");
});

test("a source that runs too long is stopped with everything in its group", async () => {
  expect(alive(process.pid)).toBe(true);
  const file = pidFile();
  // The grandchild holds stdout open, so only stopping the whole group ends the pass.
  const r = await runSource(["sh", "-c", `echo line; sleep 600 & echo $! > "$0"; wait`, file], short);
  expect(r).toEqual({ stdout: "", stderr: "", failure: `timed out after ${SHORT_SOURCE_TIMEOUT_MS / 1000}s` });
  expect(alive(Number(readFileSync(file, "utf8")))).toBe(false);
});

test("a descendant that leaves the group and holds stdout open does not hold up the pass", async () => {
  const file = pidFile();
  // Bun's detached spawn is setsid: the child is in a session of its own, out of the group's reach.
  const script = `const c = Bun.spawn(["sleep", "600"], { stdio: ["ignore", "inherit", "inherit"], detached: true });
    require("node:fs").writeFileSync(${JSON.stringify(file)}, String(c.pid)); c.unref(); console.log("line");`;
  const r = await runSource([process.execPath, "-e", script], short);
  escaped.push(Number(readFileSync(file, "utf8")));
  expect(r.failure).toBe(`timed out after ${SHORT_SOURCE_TIMEOUT_MS / 1000}s`);
  expect(r.stdout).toBe("");
});

test("a background process left behind by a command that succeeded is stopped", async () => {
  const file = pidFile();
  const r = await runSource(["sh", "-c", `sleep 600 >/dev/null 2>&1 & echo $! > "$0"; echo line`, file]);
  expect(r).toEqual({ stdout: "line\n", stderr: "" });
  expect(alive(Number(readFileSync(file, "utf8")))).toBe(false);
});

test("output over the line or byte limit is a failure, and the command is stopped", async () => {
  expect(await runSource(["yes", "{}"], { ...SOURCE_LIMITS, maxLines: 1000 })).toEqual({
    stdout: "",
    stderr: "",
    failure: "printed more than 1000 lines",
  });
  expect(
    await runSource(["sh", "-c", "while :; do printf xxxxxxxxxxxxxxxx; done"], { ...SOURCE_LIMITS, maxBytes: 4096 }),
  ).toEqual({
    stdout: "",
    stderr: "",
    failure: "printed more than 4096 bytes",
  });
  // Exactly at the limits is fine.
  expect(await runSource(["sh", "-c", "printf 'a\\nb\\n'"], { ...SOURCE_LIMITS, maxLines: 2, maxBytes: 4 })).toEqual({
    stdout: "a\nb\n",
    stderr: "",
  });
});

test("only the end of a long stderr is kept", async () => {
  const r = await runSource([
    "sh",
    "-c",
    'i=0; while [ $i -lt 2000 ]; do echo "warning $i" >&2; i=$((i+1)); done; echo ok',
  ]);
  expect(r.stdout).toBe("ok\n");
  expect(r.stderr.length).toBeLessThanOrEqual(8 * 1024);
  expect(r.stderr.length).toBeGreaterThan(7 * 1024);
  expect(r.stderr.endsWith("warning 1999\n")).toBe(true);
});

test("the source does not see the feeder's token or job socket", async () => {
  const before = { token: process.env.CNOC_TOKEN, sock: process.env.CNOC_SOCK };
  process.env.CNOC_TOKEN = "secret-token";
  process.env.CNOC_SOCK = "/nowhere.sock";
  try {
    const r = await runSource(["sh", "-c", 'echo "${CNOC_TOKEN:-none} ${CNOC_SOCK:-none} ${HOME:+home}"']);
    expect(r.stdout).toBe("none none home\n");
  } finally {
    for (const [k, v] of [
      ["CNOC_TOKEN", before.token],
      ["CNOC_SOCK", before.sock],
    ] as const)
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
});

test("an abort stops the command", async () => {
  const stop = new AbortController();
  const file = pidFile();
  const running = runSource(["sh", "-c", `echo $$ > "$0"; exec sleep 600`, file], SOURCE_LIMITS, stop.signal);
  while (!existsSync(file) || readFileSync(file, "utf8") === "") await Bun.sleep(POLL_MS);
  stop.abort();
  expect(await running).toMatchObject({ failure: "stopped" });
  expect(alive(Number(readFileSync(file, "utf8")))).toBe(false);
});
