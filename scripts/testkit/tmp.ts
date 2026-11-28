// doing-it-wrong-ignore-file no-raw-temp: this repository's own temp owner, which removes what it makes (#10)
/**
 * THE ONE WAY A SPEC MAKES A THROWAWAY DIRECTORY.
 *
 * WHY. A spec that calls `mkdtempSync(join(tmpdir(), "<prefix>-"))` directly removes the result
 * only if it runs to its `afterEach` / `afterAll`, and many never remove it at all. Nothing goes
 * red; the temp directory fills, one entry per run.
 *
 * THE RUN'S ROOT. Every directory made here lands under ONE directory named for the test
 * process, `<tmpdir>/cnoc-test-tmp-<pid>/`, and nowhere else. Two parties remove it:
 *
 * - The preload (`./preload.ts`, named by the root `bunfig.toml`) registers
 *   {@link sweepSpecTempDirs} as a GLOBAL `afterAll`, which bun runs once after the last
 *   file. A finished `bun test` leaves nothing behind.
 * - A run that never reached it (killed) is collected BY PID by the next run:
 *   {@link reapDeadSpecTempRoots} removes every root whose pid no longer exists. Age is the
 *   wrong test: a concurrent run's root is young and live. Pid reuse can only KEEP a dead
 *   root a little longer, never delete a live one.
 *
 * `tmpScope()` / `tmpDir()` narrow the blast radius further, to one `using` block, on the
 * returning AND the throwing path. `using` does not run on a signal; the pid reaper does
 * the rest.
 *
 * The built-in `no-raw-temp` and the repo rule `no-tmpdir-env` refuse a raw `mkdtemp` / `tmpdir()` /
 * `$TMPDIR` anywhere but here and the non-spec owner, `./scratch.ts` (`scratchDir`): both owners
 * carry a file waiver (#10).
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reapDeadPidRoots } from "./scratch";

export const SPEC_TMP_PREFIX = "cnoc-test-tmp-";

let specRoot: string | undefined;

/** Remove every `cnoc-test-tmp-<pid>` root under `base` whose process is gone. */
export function reapDeadSpecTempRoots(base: string = tmpdir(), alive?: (pid: number) => boolean): string[] {
  return reapDeadPidRoots(SPEC_TMP_PREFIX, base, alive);
}

/** This process's root, made (and the dead ones reaped) on first use. */
export function specTempRoot(): string {
  if (specRoot === undefined) {
    const base = tmpdir();
    reapDeadSpecTempRoots(base);
    specRoot = join(base, `${SPEC_TMP_PREFIX}${process.pid}`);
  }
  mkdirSync(specRoot, { recursive: true });
  return specRoot;
}

/**
 * `mkdtemp` under this run's root, so it is swept with the run. A drop-in for
 * `mkdtempSync(join(tmpdir(), prefix))`. A spec may still remove it early itself.
 */
export function specTempDir(prefix: string): string {
  return mkdtempSync(join(specTempRoot(), prefix));
}

/** Remove this run's root. The preload's global `afterAll`. */
export function sweepSpecTempDirs(): void {
  if (specRoot !== undefined) rmSync(specRoot, { recursive: true, force: true });
}

/**
 * A set of throwaway directories, removed together when the scope is disposed.
 *
 * ```ts
 * test("…", () => {
 *   using fx = tmpScope();
 *   const dir = fx.dir("my-fixture-");
 * });
 * ```
 */
export class TmpScope implements Disposable {
  readonly #owned: string[] = [];
  readonly #deferred: Array<() => void> = [];
  #disposed = false;

  /** `mkdtemp` under the run's root. The scope owns the result. */
  dir(prefix: string): string {
    this.#assertLive();
    const made = specTempDir(prefix);
    this.#owned.push(made);
    return made;
  }

  /** Take ownership of a path this scope did not create. */
  adopt(path: string): string {
    this.#assertLive();
    this.#owned.push(path);
    return path;
  }

  /** Run `fn` at disposal, BEFORE any directory is removed (reverse registration order). */
  defer(fn: () => void): void {
    this.#assertLive();
    this.#deferred.push(fn);
  }

  /** Everything the scope will remove, in creation order. For assertions. */
  get owned(): readonly string[] {
    return this.#owned;
  }

  /**
   * Remove everything, deferred callbacks first. Every step is attempted even when an
   * earlier one throws, and the first error is re-thrown afterwards.
   */
  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    let first: unknown;
    const attempt = (fn: () => void) => {
      try {
        fn();
      } catch (e) {
        first ??= e;
      }
    };
    for (const fn of [...this.#deferred].reverse()) attempt(fn);
    for (const path of [...this.#owned].reverse()) attempt(() => rmSync(path, { recursive: true, force: true }));
    if (first !== undefined) throw first;
  }

  #assertLive(): void {
    if (this.#disposed) throw new Error("TmpScope: used after disposal");
  }
}

/** `using fx = tmpScope();` — see {@link TmpScope}. */
export function tmpScope(): TmpScope {
  return new TmpScope();
}

/** One throwaway directory: `using d = tmpDir("my-spec-"); writeFileSync(join(d.path, "x"), …)`. */
export class TmpDir implements Disposable {
  readonly #scope = new TmpScope();
  readonly path: string;

  constructor(prefix: string) {
    this.path = this.#scope.dir(prefix);
  }

  [Symbol.dispose](): void {
    this.#scope[Symbol.dispose]();
  }
}

/** `using d = tmpDir("prefix-");` — see {@link TmpDir}. */
export function tmpDir(prefix: string): TmpDir {
  return new TmpDir(prefix);
}
