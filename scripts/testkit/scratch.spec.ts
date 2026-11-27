import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { SCRATCH_PREFIX, reapDeadPidRoots, scratchDir } from "./scratch";
import { specTempDir } from "./tmp";

const SCRATCH_TS = join(import.meta.dir, "scratch.ts");

/**
 * Run a child bun that mints scratch, prints its path, then ends the way `how` says. Its TMPDIR is a dir of this spec's
 * own: every process that mints scratch (and every `bun test` preload, in any worktree) reaps dead-pid roots in ITS
 * TMPDIR, so in the shared one another run could remove the SIGKILLed child's root before this spec's reap does
 * (seen once in a full `am-i-done --ci` while other lanes ran: `reaped` was []).
 */
function child(how: "exit" | "sigkill"): { path: string; pid: number } {
  const end = how === "exit" ? "process.exit(0);" : 'process.kill(process.pid, "SIGKILL");';
  const src = `const { scratchDir } = await import(${JSON.stringify(SCRATCH_TS)});
const s = scratchDir("child-");
console.log(JSON.stringify({ path: s.path, pid: process.pid }));
${end}`;
  const r = spawnSync("bun", ["-e", src], {
    encoding: "utf8",
    env: { ...process.env, TMPDIR: specTempDir("scratch-child-") },
  });
  return JSON.parse(r.stdout.trim().split("\n")[0] as string) as { path: string; pid: number };
}

describe("scratchDir", () => {
  test("lands under this process's pid-named root and release removes it (idempotent)", () => {
    const s = scratchDir("core-spec-");
    expect(existsSync(s.path)).toBe(true);
    expect(basename(dirname(s.path))).toBe(`${SCRATCH_PREFIX}${process.pid}`);
    s.release();
    expect(existsSync(s.path)).toBe(false);
    s.release();
  });

  test("a process that exits removes its whole scratch root", () => {
    const c = child("exit");
    expect(basename(dirname(c.path))).toBe(`${SCRATCH_PREFIX}${c.pid}`);
    expect(existsSync(dirname(c.path))).toBe(false);
  });

  test("a SIGKILLed process strands its root, and the next reap removes it by pid", () => {
    const c = child("sigkill");
    const root = dirname(c.path);
    expect(existsSync(root)).toBe(true);
    const reaped = reapDeadPidRoots(SCRATCH_PREFIX, dirname(root));
    expect(reaped).toContain(root);
    expect(existsSync(root)).toBe(false);
  });
});
