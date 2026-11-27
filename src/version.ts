/**
 * Which code this process runs.
 *
 * The version is the git commit of the checkout the code was loaded from, with `-dirty` appended
 * when tracked files differ from that commit. A server and a client agree when the strings are
 * equal, and a client that disagrees moves its checkout to the server's commit (client/update.ts).
 *
 * - `CNOC_VERSION` overrides it, for tests and for installs that are not git checkouts.
 * - Without git or a checkout, the fallback is `VERSION` from protocol.ts.
 * - A dirty tree still compares equal to the same dirty string, so a server and a client run from
 *   one working copy connect. No other host can reach it: a client asked to update to a `-dirty`
 *   version refuses, because no commit holds that code.
 *
 * It costs two `git` calls, so it is resolved once and only by the processes that compare versions
 * (server, client, `cnoc version`). `cnoc done` inside a session never asks.
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { VERSION } from "./protocol";

/** The checkout this code runs from. */
export const APP_ROOT = resolve(import.meta.dir, "..");

/** A full git object name: SHA-1, or SHA-256 in a repository that uses it. */
export const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const DIRTY_SUFFIX = "-dirty";

export interface Checkout {
  commit: string;
  dirty: boolean;
}

/** Runs git and returns its trimmed output, or null when git is missing or fails. */
export function gitSync(dir: string, args: string[]): string | null {
  try {
    const p = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    return p.exitCode === 0 ? p.stdout.toString().trim() : null;
  } catch {
    return null; // git is not installed
  }
}

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/**
 * The commit `dir` has checked out, or null if `dir` is not the top of a git checkout. A
 * directory inside some other repository (cnoc vendored into a project, say) is not a checkout of
 * cnoc and has no commit of its own.
 */
export function checkoutOf(dir: string): Checkout | null {
  const top = gitSync(dir, ["rev-parse", "--show-toplevel"]);
  if (!top || real(top) !== real(dir)) return null;
  const commit = gitSync(dir, ["rev-parse", "HEAD"]);
  if (!commit || !COMMIT.test(commit)) return null;
  // Untracked files are left out: new code takes effect only through an edit to a tracked file.
  const status = gitSync(dir, ["status", "--porcelain", "--untracked-files=no"]);
  if (status === null) return null;
  return { commit, dirty: status !== "" };
}

/** The version string of the code in `dir`, ignoring `CNOC_VERSION`. */
export function versionOf(dir: string): string {
  const c = checkoutOf(dir);
  if (!c) return VERSION;
  return c.dirty ? `${c.commit}${DIRTY_SUFFIX}` : c.commit;
}

let cached: string | undefined;

/** The version this process runs, resolved on first use. */
export function runningVersion(): string {
  cached ??= process.env.CNOC_VERSION || versionOf(APP_ROOT);
  return cached;
}

/** A version for people: a commit shortened to 7 characters, anything else as it is. */
export function shortVersion(v: string | null | undefined): string {
  if (!v) return "-";
  const dirty = v.endsWith(DIRTY_SUFFIX);
  const base = dirty ? v.slice(0, -DIRTY_SUFFIX.length) : v;
  return COMMIT.test(base) ? `${base.slice(0, 7)}${dirty ? DIRTY_SUFFIX : ""}` : v;
}
