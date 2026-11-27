import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { specTempDir } from "../testkit";
import { killTrackedTree, runTracked, trackedPids } from "./process-tree";

// Everything here spawns real processes: the whole point of the deadline kill is
// that it survives contact with the OS, so a fake-process test would pin
// nothing. Keep it cheap — one bun child, one `sleep` grandchild.
const POLL_MS = 20;
const WAIT_BUDGET_MS = 4_000;

const tempDirs: string[] = [];
const strays: number[] = [];

function tempDir(): string {
  const d = specTempDir("process-tree-");
  tempDirs.push(d);
  return d;
}

afterEach(async () => {
  // Belt and braces: if the implementation regresses, don't leak a spinner.
  await killTrackedTree({ graceMs: POLL_MS });
  for (const pid of strays.splice(0)) if (alive(pid)) process.kill(pid, "SIGKILL");
  while (tempDirs.length) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

// A signal-0 probe is the only way to ask "does this pid still exist"; the throw
// IS the negative answer, so there is no error here to assert on.
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
    // dotw-ignore test-empty-catch: ESRCH is the "not alive" answer, not a swallowed failure
  } catch {
    return false;
  }
}

/** Poll a condition to a deadline — test the CONDITION, never time passing. */
async function waitFor(label: string, cond: () => boolean): Promise<void> {
  const deadline = Date.now() + WAIT_BUDGET_MS;
  while (Date.now() < deadline) {
    if (cond()) return;
    await Bun.sleep(POLL_MS);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

/**
 * Spawn a tracked child that itself spawns a long-lived grandchild and then
 * hangs forever without ever forwarding signals. If only the direct child is
 * signalled, the grandchild is re-parented to init and survives — which is
 * exactly the wedge this module exists to reap.
 */
function spawnTreeWithGrandchild(pidPath: string): { childPid: number } {
  const dir = tempDir();
  const script = join(dir, "parent.ts");
  writeFileSync(
    script,
    [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      'const gc = spawn("sleep", ["30"], { stdio: "ignore" });',
      `writeFileSync(${JSON.stringify(pidPath)}, String(gc.pid));`,
      "await new Promise(() => {});",
    ].join("\n"),
  );
  const child = runTracked("bun", [script], { env: { ...process.env } });
  expect(child.pid).toBeDefined();
  return { childPid: child.pid as number };
}

function readPid(path: string): number | null {
  if (!existsSync(path)) return null;
  const n = Number(readFileSync(path, "utf8").trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

describe("process-tree", () => {
  it("killTrackedTree is a no-op when nothing is tracked", async () => {
    const result = await killTrackedTree();
    expect(result.killed).toEqual([]);
    expect(result.survivors).toEqual([]);
  });

  it("kills the whole tree — a grandchild the direct child never signals dies too", async () => {
    const pidPath = join(tempDir(), "grandchild.pid");
    const { childPid } = spawnTreeWithGrandchild(pidPath);
    expect(trackedPids()).toContain(childPid);

    await waitFor("grandchild to report its pid", () => readPid(pidPath) !== null);
    const gcPid = readPid(pidPath) as number;
    strays.push(gcPid, childPid);
    expect(alive(gcPid)).toBe(true);

    const result = await killTrackedTree({ graceMs: WAIT_BUDGET_MS });

    expect(result.killed).toContain(childPid);
    expect(result.survivors).toEqual([]);
    // The load-bearing assertion: the grandchild, not just the child.
    await waitFor("grandchild to die", () => !alive(gcPid));
    expect(alive(gcPid)).toBe(false);
    // The direct child is OUR child: once killed it is a zombie, and a signal-0 probe still finds a zombie, until
    // Bun's event loop reaps it. Under load (the coverage run) the reap can land after the grandchild is gone, so
    // poll the condition instead of asserting it at one instant.
    await waitFor("child to be reaped", () => !alive(childPid));
    expect(alive(childPid)).toBe(false);
  });

  it("forgets a child once it exits, so a later kill has nothing to signal", async () => {
    const child = runTracked("true", [], { env: { ...process.env } });
    const pid = child.pid as number;
    expect(trackedPids()).toContain(pid);
    await waitFor("child to exit and deregister", () => !trackedPids().includes(pid));

    const result = await killTrackedTree();
    expect(result.killed).toEqual([]);
  });

  // Bun's node:child_process could emit 'exit'/'close' inside spawn(), before
  // any listener existed, so the caller hung and the pid stayed tracked. `done`
  // is a promise: awaiting it only after the child is long gone must still settle.
  it("settles and deregisters a child that exited before anyone awaited it", async () => {
    const out: string[] = [];
    const child = runTracked("sh", ["-c", "printf early-bird"], {
      env: { ...process.env },
      onStdout: (d) => out.push(d),
    });
    const pid = child.pid as number;
    await waitFor("child to be gone from the process table", () => !alive(pid));

    const exit = await child.done;
    expect(exit).toEqual({ code: 0, signal: null });
    expect(out.join("")).toBe("early-bird");
    expect(trackedPids()).not.toContain(pid);
  });

  it("reports a child that could not start, and tracks nothing for it", async () => {
    const child = runTracked("/this/path/definitely/does/not/exist-xyz-12345", [], { env: { ...process.env } });
    expect(child.pid).toBeUndefined();
    const exit = await child.done;
    expect(exit.code).toBeNull();
    expect(exit.error).toBeTruthy();
    expect(trackedPids()).toEqual([]);
  });

  it("drops undefined env values and reports a signal as signal, not code", async () => {
    const child = runTracked("sh", ["-c", '[ -z "${GONE+x}" ] && kill -TERM $$'], {
      env: { ...process.env, GONE: undefined },
    });
    const exit = await child.done;
    expect(exit).toEqual({ code: null, signal: "SIGTERM" });
  });
});
