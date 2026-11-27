/**
 * NON-SPEC SCRATCH: a directory a script or a long-lived process mints and must not strand.
 * It lives beside the spec helpers because the gate scripts are its only users today. When
 * production code needs scratch, move this file there and update the `no-raw-mkdtemp` owners.
 *
 * WHERE. Every scratch directory of a process lands under ONE root named for it,
 * `<tmpdir>/cnoc-scratch-<pid>/<prefix>XXXXXX`, never loose in `$TMPDIR`.
 *
 * WHO REMOVES IT, on each way a process ends:
 *   - `release()` (the owner's own `close()`), and `withScratchDir`'s `finally`: the normal path.
 *   - `process.on("exit")` removes the whole root: a `process.exit()` from anywhere.
 *   - A process that died without unwinding (an unhandled SIGTERM, SIGKILL, an OOM kill, a
 *     power cut) leaves its root behind, and the NEXT process to mint scratch removes every
 *     root whose pid is gone ({@link reapDeadPidRoots}). A dead run's scratch survives at most
 *     until the next one starts. Pid reuse can only keep a root longer, never remove a live one.
 *   - Under `bun test` the preload (`./preload.ts`) calls {@link releaseAllScratch} in its
 *     global `afterAll`.
 *
 * NO SIGNAL HANDLERS, deliberately. A handler that releases and exits replaces the process's
 * default disposition and races a long-lived server's own orderly shutdown. A server with its
 * own handlers must keep them, so this module installs none; the pid reaper covers the death
 * that does not unwind.
 *
 * The rule `no-raw-mkdtemp` (scripts/rules) allows the raw primitive only here and in
 * `./tmp.ts`.
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SCRATCH_PREFIX = "cnoc-scratch-";

/** True when `pid` names a live process (EPERM: it exists and belongs to somebody else). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Remove every `<prefix><pid>` entry under `base` whose process is gone. Only a name that is
 * exactly `prefix` followed by a positive integer is ever touched; this process's own entry
 * and any live pid's are kept. Returns what it removed.
 */
export function reapDeadPidRoots(
  prefix: string,
  base: string = tmpdir(),
  alive: (pid: number) => boolean = pidAlive,
): string[] {
  const reaped: string[] = [];
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return reaped; // no base directory: nothing to reap
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const tail = name.slice(prefix.length);
    if (!/^\d+$/.test(tail)) continue;
    const pid = Number(tail);
    if (pid <= 0 || pid === process.pid || alive(pid)) continue;
    try {
      rmSync(join(base, name), { recursive: true, force: true });
      reaped.push(join(base, name));
    } catch {
      // another process reaped it first, or it is not removable by us: leave it
    }
  }
  return reaped;
}

/** A directory this module minted and will remove. */
export class Scratch {
  #live = true;
  constructor(readonly path: string) {}

  /** Remove it now. Idempotent, never throws. */
  release(): void {
    if (!this.#live) return;
    this.#live = false;
    try {
      rmSync(this.path, { recursive: true, force: true });
    } catch {
      // the exit hook or the next process's reaper removes it with the root
    }
  }
}

let root: string | undefined;
let installed = false;

function scratchRoot(): string {
  if (root === undefined) {
    const base = tmpdir();
    reapDeadPidRoots(SCRATCH_PREFIX, base);
    root = join(base, `${SCRATCH_PREFIX}${process.pid}`);
  }
  mkdirSync(root, { recursive: true });
  if (!installed) {
    installed = true;
    process.on("exit", releaseAllScratch);
  }
  return root;
}

/** Remove this process's scratch root and everything in it. Sync, so safe from an `exit` hook. */
export function releaseAllScratch(): void {
  if (root === undefined) return;
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // an exit hook must not throw; the next process reaps the root by pid
  }
}

/** Mint a scratch directory under this process's root. */
export function scratchDir(prefix: string): Scratch {
  return new Scratch(mkdtempSync(join(scratchRoot(), prefix)));
}
