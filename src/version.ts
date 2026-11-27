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
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { VERSION } from "./protocol";

/** The checkout this code runs from. */
export const APP_ROOT = resolve(import.meta.dir, "..");

/** A full git object name: SHA-1, or SHA-256 in a repository that uses it. */
export const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const DIRTY_SUFFIX = "-dirty";
/** A version that is not a commit but is still safe to show, compare and pass on. */
export const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
/** What the server records for a host whose reported version is not safe to keep. Not itself a safe version, so no host can send it. */
export const INVALID_VERSION = "(invalid)";
/** A read-only git call at start-up may take this long; past it, the version is the fallback. */
const GIT_READ_TIMEOUT_MS = 10_000;

export interface Checkout {
  commit: string;
  dirty: boolean;
}

export interface GitResult {
  ok: boolean;
  out: string;
  /** Why it failed: git's last line of stderr, or that git could not be started. */
  err: string;
}

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/**
 * Runs a read-only git command in `dir`. The directory is named safe for this call only, so a
 * checkout owned by another user (a service account running someone's clone) still reports
 * its commit instead of being refused.
 */
export function gitSync(dir: string, args: string[]): GitResult {
  try {
    const p = Bun.spawnSync(
      ["git", "-c", `safe.directory=${dir}`, "-c", `safe.directory=${real(dir)}`, "-C", dir, ...args],
      { env: process.env, stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: GIT_READ_TIMEOUT_MS },
    );
    const err = p.stderr.toString().trim().split("\n").at(-1)?.trim() ?? "";
    if (p.exitCode === 0) return { ok: true, out: p.stdout.toString().trim(), err: "" };
    return { ok: false, out: "", err: err || (p.signalCode ? `timed out (${p.signalCode})` : `exit ${p.exitCode}`) };
  } catch (e) {
    return { ok: false, out: "", err: `git could not be run: ${(e as Error).message}` };
  }
}

/**
 * The commit `dir` has checked out, or why there is none. A directory inside some other
 * repository (cnoc vendored into a project, say) is not a checkout of cnoc.
 */
export function inspectCheckout(dir: string): { checkout: Checkout | null; problem: string | null } {
  const fail = (problem: string) => ({ checkout: null, problem });
  const top = gitSync(dir, ["rev-parse", "--show-toplevel"]);
  if (!top.ok)
    return fail(existsSync(join(dir, ".git")) ? `git failed in ${dir}: ${top.err}` : `${dir} is not a git checkout`);
  if (real(top.out) !== real(dir)) return fail(`${dir} is inside another repository (${top.out})`);
  const head = gitSync(dir, ["rev-parse", "HEAD"]);
  if (!head.ok || !COMMIT.test(head.out)) return fail(`git rev-parse HEAD failed in ${dir}: ${head.err}`);
  // Untracked files are left out: new code takes effect only through an edit to a tracked file.
  const status = gitSync(dir, ["status", "--porcelain", "--untracked-files=no"]);
  if (!status.ok) return fail(`git status failed in ${dir}: ${status.err}`);
  return { checkout: { commit: head.out, dirty: status.out !== "" }, problem: null };
}

export function checkoutOf(dir: string): Checkout | null {
  return inspectCheckout(dir).checkout;
}

const versionString = (c: Checkout): string => (c.dirty ? `${c.commit}${DIRTY_SUFFIX}` : c.commit);

/** The version string of the code in `dir`, ignoring `CNOC_VERSION`. */
export function versionOf(dir: string): string {
  const c = checkoutOf(dir);
  return c ? versionString(c) : VERSION;
}

/**
 * Why a version strands other hosts, or null when it does not: a fallback because git could
 * not say which commit this is, or a dirty tree. Both leave clients unable to update to it.
 */
export function versionProblem(dir: string, seen = inspectCheckout(dir)): string | null {
  const { checkout, problem } = seen;
  if (!checkout)
    return `the version is the fallback ${VERSION} because ${problem}. Clients cannot update to it; fix that, or set CNOC_VERSION on every host`;
  if (checkout.dirty)
    return `${dir} has uncommitted changes, so the version is ${shortVersion(versionString(checkout))}. No other host can update to it; commit and push, or discard them`;
  return null;
}

let cached: { version: string; problem: string | null } | undefined;

function resolveRunning(): { version: string; problem: string | null } {
  if (process.env.CNOC_VERSION) return { version: process.env.CNOC_VERSION, problem: null };
  const seen = inspectCheckout(APP_ROOT);
  return {
    version: seen.checkout ? versionString(seen.checkout) : VERSION,
    problem: versionProblem(APP_ROOT, seen),
  };
}

/** The version this process runs, resolved on first use. */
export function runningVersion(): string {
  cached ??= resolveRunning();
  return cached.version;
}

/** Why this process's version strands other hosts, for a warning at start; null if it does not. */
export function runningVersionProblem(): string | null {
  cached ??= resolveRunning();
  return cached.problem;
}

/** Text from another party, made safe for one line of a terminal: no control characters, bounded. */
export function printable(s: string, max = 300): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
  const clean = s.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** A version for people: a commit shortened to 7 characters, anything else made printable. */
export function shortVersion(v: string | null | undefined): string {
  if (!v) return "-";
  const dirty = v.endsWith(DIRTY_SUFFIX);
  const base = dirty ? v.slice(0, -DIRTY_SUFFIX.length) : v;
  if (COMMIT.test(base)) return `${base.slice(0, 7)}${dirty ? DIRTY_SUFFIX : ""}`;
  return SAFE_VERSION.test(v) || v === INVALID_VERSION ? v : JSON.stringify(printable(v, 60));
}
