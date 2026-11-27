/**
 * Bringing a client to the server's version.
 *
 * The built-in procedure moves the checkout the client runs from to exactly the commit the server
 * names: fetch it from `origin`, check it out detached, install dependencies. It never follows a
 * branch, so a branch that has moved on cannot leave the client one commit short and looping. If
 * a step after the checkout fails, the previous commit is checked out again, so a host is never
 * left on new code with old dependencies.
 *
 * The commit is only ever an argument to git, never part of a shell string, and it must look like
 * a full object name. The server can choose which commit of the clone's own `origin` to run; it
 * cannot choose where it comes from or run anything that is not a commit there.
 *
 * Every try is recorded in `update.json` in the state directory, so the wait between tries grows
 * across restarts and not only within one process. If the disk refuses the record, it is kept in
 * memory. A new target is tried at once. Going back to a version this client already ran within
 * the hour is capped, so a server flapping between versions cannot make a host thrash, while any
 * number of new deploys go through. A client exits for
 * a restart only when that can help: the checkout moved, or the code was already in place but this
 * process may predate it.
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMMIT, DIRTY_SUFFIX, SAFE_VERSION, checkoutOf, printable, shortVersion, versionOf } from "../version";

/** The wait after the first unsuccessful try for a target. It doubles with each further try. */
export const UPDATE_RETRY_BASE_MS = 60_000;
/** The longest wait between two tries. */
export const UPDATE_RETRY_MAX_MS = 30 * 60_000;
/**
 * At most this many restarts within {@link UPDATE_RESTART_WINDOW_MS} may go back to a version this
 * client already ran within that window. A version it has not run in the window always proceeds.
 */
export const UPDATE_RESTART_LIMIT = 5;
export const UPDATE_RESTART_WINDOW_MS = 60 * 60_000;
/** One git or bun step may take this long before it is stopped and the try counts as failed. */
const UPDATE_STEP_TIMEOUT_MS = 5 * 60_000;

/**
 * The `update` command older configs carry: install.sh wrote one quoted form into every config,
 * and the example config showed an unquoted one. Both pull a branch, not the server's commit, so
 * they are ignored for the built-in procedure. install.sh uses this same pattern to remove them.
 * install.sh also keeps a copy, LEGACY_UPDATE_SOURCE, for code from before this file: change both
 * (test/install.test.ts fails while they differ).
 */
export const LEGACY_UPDATE = /^git -C .* pull -q --ff-only && .* install --cwd .* --frozen-lockfile --production$/;

export interface UpdateState {
  /** The server version these tries were for. */
  target: string;
  tries: number;
  /** Earliest time of the next try, epoch milliseconds. */
  next_at: number;
  /** Why the last try did not end in a restart, or null if it did. */
  reason: string | null;
  /** Some try for this target has already ended in a restart. */
  restarted: boolean;
  at: number;
  /**
   * When recent tries ended in a restart, for any target. Kept as the previous version wrote it,
   * so that a client downgraded to it still has its history; this version does not count it.
   */
  restarts?: number[];
  /** The version each recent restart left, and when. Absent in a record the previous version wrote. */
  left?: Array<{ version: string; at: number }>;
  /** When recent restarts went back to a version in `left`; these count against the limit. */
  returns?: number[];
  /** The wait is for {@link UPDATE_RESTART_LIMIT}, which may be longer than the longest retry wait. */
  held?: boolean;
}

/** How the previous version said it was holding for its restart limit, which counted every restart. */
const LEGACY_HOLD = /restarts for updates in the last hour/;

/**
 * A record as this version reads it. One written by the previous version has no `left`: its
 * restarts name no versions, so none of them counts as a return, and a hold it made for its
 * restart limit (which counted new deploys too) is dropped, so the target is tried at once.
 */
export function readState(raw: UpdateState): UpdateState {
  if (Array.isArray(raw.left)) return raw;
  const legacyHold = typeof raw.reason === "string" && LEGACY_HOLD.test(raw.reason);
  return { ...raw, left: [], returns: [], ...(legacyHold ? { next_at: 0, reason: null } : {}) };
}

export class UpdateError extends Error {}

export interface UpdaterOptions {
  /** The checkout the built-in procedure moves. */
  checkout: string;
  stateDir: string;
  /** The version this process runs. */
  version: string;
  /** The config's `update` command, if any. */
  command?: string;
  /** The bun that installs dependencies. Default: the one running this process. */
  bun?: string;
  log: (line: string) => void;
  now?: () => number;
}

const short = shortVersion;

export function retryDelayMs(tries: number): number {
  return Math.min(UPDATE_RETRY_BASE_MS * 2 ** Math.max(0, tries - 1), UPDATE_RETRY_MAX_MS);
}

const duration = (ms: number): string =>
  ms < 60_000
    ? `${Math.ceil(ms / 1000)}s`
    : ms < 3_600_000
      ? `${Math.round(ms / 60_000)}m`
      : `${(ms / 3_600_000).toFixed(1)}h`;

export class Updater {
  private busy = false;
  private readonly command: string | undefined;
  private readonly now: () => number;
  /** The latest record this process made; it wins over the file, which may be stale or unwritable. Undefined: read the file. */
  private mem: UpdateState | null | undefined;
  private diskWarned = false;

  constructor(private o: UpdaterOptions) {
    this.now = o.now ?? Date.now;
    this.command = o.command && !LEGACY_UPDATE.test(o.command) ? o.command : undefined;
    if (o.command && !this.command)
      o.log(
        `ignoring the config's "update" command: an older install.sh wrote it, and updates are now built in. Remove it from the config, or re-run install.sh, to silence this`,
      );
  }

  private get file(): string {
    return join(this.o.stateDir, "update.json");
  }

  state(): UpdateState | null {
    if (this.mem !== undefined) return this.mem;
    try {
      return readState(JSON.parse(readFileSync(this.file, "utf8")) as UpdateState);
    } catch {
      return null; // none yet, or unreadable: either way there is no backoff to honour
    }
  }

  /** The restart history still inside the window at `now`. */
  private history(s: UpdateState | null, now: number): Required<Pick<UpdateState, "restarts" | "left" | "returns">> {
    const recent = (t: number) => now - t < UPDATE_RESTART_WINDOW_MS && t <= now;
    return {
      restarts: (s?.restarts ?? []).filter(recent),
      left: (s?.left ?? []).filter((l) => recent(l.at)),
      returns: (s?.returns ?? []).filter(recent),
    };
  }

  /** The versions agree again: forget past tries, but not the restart history. */
  clear(): void {
    const s = this.state();
    if (!s || s.target === "") return;
    const now = this.now();
    const h = this.history(s, now);
    if (h.restarts.length + h.left.length + h.returns.length > 0) {
      // Keep only what the flap guard needs; no target, so nothing waits on it.
      this.record({ target: "", tries: 0, next_at: 0, reason: null, restarted: false, at: now, ...h });
      return;
    }
    this.mem = null;
    try {
      if (existsSync(this.file)) rmSync(this.file, { force: true });
    } catch (e) {
      this.diskTrouble(e);
    }
  }

  /**
   * Milliseconds until a try for `target` is due; 0 when it is due now. Never more than the
   * longest wait (the restart window, for a hold on the restart limit), whatever the clock did.
   */
  dueIn(target: string): number {
    const s = this.state();
    if (!s || s.target !== target) return 0;
    return Math.min(Math.max(0, s.next_at - this.now()), s.held ? UPDATE_RESTART_WINDOW_MS : UPDATE_RETRY_MAX_MS);
  }

  /** One line for the server about what this client is doing to reach `target`. */
  note(target: string): string {
    const s = this.state();
    if (this.busy || !s || s.target !== target) return `updating to ${short(target)}`;
    const next = `next try in ${duration(this.dueIn(target))}`;
    if (s.reason) return `update to ${short(target)} failed (try ${s.tries}): ${s.reason}; ${next}`;
    return `restarted for ${short(target)} but still runs ${short(this.o.version)}; ${next}`;
  }

  /**
   * Tries to update to `target` if a try is due and none is running. Resolves true when the
   * client should exit so that its service manager starts the new code. Never rejects.
   */
  async attempt(target: string): Promise<boolean> {
    if (this.busy || this.dueIn(target) > 0) return false;
    this.busy = true;
    try {
      return await this.tryOnce(target);
    } catch (e) {
      this.o.log(`update to ${short(target)} failed unexpectedly: ${(e as Error).message}`);
      return false;
    } finally {
      this.busy = false;
    }
  }

  private async tryOnce(target: string): Promise<boolean> {
    const prev = this.state();
    const same = prev?.target === target ? prev : null;
    const tries = (same?.tries ?? 0) + 1;
    const start = this.now();
    const h = this.history(prev, start);
    // Only going back to a version this client ran within the window can be a flap.
    const back = h.left.some((l) => l.version === target);

    if (back && h.returns.length >= UPDATE_RESTART_LIMIT) {
      // Due when the oldest return leaves the window, and the budget has room again.
      const wait = Math.max(1000, Math.min(...h.returns) + UPDATE_RESTART_WINDOW_MS - start);
      const reason = `${h.returns.length} restarts in the last hour went back to a version this client had already run; is the server's version changing back and forth?`;
      this.record({
        target,
        tries,
        next_at: start + wait,
        reason,
        restarted: same?.restarted === true,
        at: start,
        ...h,
        held: true,
      });
      this.o.log(`not updating to ${short(target)} yet: ${reason} Next try in ${duration(wait)}`);
      return false;
    }

    let reason: string | null = null;
    let restart = false;
    try {
      const changed = await this.apply(target);
      // A second restart onto code that is already in place would only loop.
      restart = changed || !same?.restarted;
      if (!restart)
        reason = `the code for ${short(target)} is in place but this client still reports ${short(this.o.version)}; is CNOC_VERSION set?`;
    } catch (e) {
      reason = printable(e instanceof UpdateError ? e.message : `unexpected error: ${(e as Error).message}`, 400);
    }
    const delay = retryDelayMs(tries);
    const now = this.now();
    this.record({
      target,
      tries,
      next_at: now + delay,
      reason,
      restarted: restart || same?.restarted === true,
      at: now,
      ...(restart
        ? {
            restarts: [...h.restarts, now],
            left: [...h.left, { version: this.o.version, at: now }],
            returns: back ? [...h.returns, now] : h.returns,
          }
        : h),
    });
    this.o.log(
      restart
        ? `server runs ${short(target)}, this client ${short(this.o.version)}: updated; exiting so the service manager starts it`
        : `update to ${short(target)} failed: ${reason}; next try in ${duration(delay)}`,
    );
    return restart;
  }

  private record(s: UpdateState): void {
    this.mem = s;
    this.write(s);
  }

  private write(s: UpdateState): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(s));
      renameSync(tmp, this.file);
    } catch (e) {
      this.diskTrouble(e);
      try {
        rmSync(tmp, { force: true, recursive: false });
      } catch {
        // Nothing more to do: the record is in memory and the problem has been logged.
      }
    }
  }

  private diskTrouble(e: unknown): void {
    if (this.diskWarned) return;
    this.diskWarned = true;
    this.o.log(
      `cannot write ${this.file} (${(e as Error).message}); keeping the update backoff in memory, so it will not survive a restart`,
    );
  }

  private async apply(target: string): Promise<boolean> {
    if (!this.command) return updateCheckout(this.o.checkout, target, this.o.bun ?? process.execPath);
    if (!SAFE_VERSION.test(target))
      throw new UpdateError(`refusing to pass version ${short(target)} to the update command`);
    const before = checkoutOf(this.o.checkout) ? versionOf(this.o.checkout) : null;
    const r = await run(["sh", "-c", this.command], undefined, { CNOC_TARGET_VERSION: target });
    if (!r.ok) throw new UpdateError(`the configured update command failed${r.err ? `: ${r.err}` : ""}`);
    // In a git checkout the version is the commit, so it can be checked instead of trusted.
    if (before === null) return true;
    const now = versionOf(this.o.checkout);
    if (now === target) return now !== before;
    throw new UpdateError(`the configured update command succeeded but left ${this.o.checkout} at ${short(now)}`);
  }
}

interface RunResult {
  ok: boolean;
  /** The last line the command wrote to stderr. */
  err: string;
}

async function run(cmd: string[], cwd?: string, env: Record<string, string> = {}): Promise<RunResult> {
  try {
    const p = Bun.spawn(cmd, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      timeout: UPDATE_STEP_TIMEOUT_MS,
    });
    const [code, stderr] = await Promise.all([p.exited, new Response(p.stderr).text()]);
    const last = printable(stderr.trim().split("\n").at(-1)?.trim() ?? "", 200);
    return { ok: code === 0, err: p.signalCode ? `stopped (${p.signalCode})` : last };
  } catch (e) {
    return { ok: false, err: (e as Error).message };
  }
}

const git = (dir: string, args: string[]) => run(["git", "-C", dir, ...args]);
const hasCommit = async (dir: string, commit: string) => (await git(dir, ["cat-file", "-e", `${commit}^{commit}`])).ok;
const gitOut = async (dir: string, args: string[]): Promise<string | null> => {
  const p = Bun.spawn(["git", "-C", dir, ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const [code, out] = await Promise.all([p.exited, new Response(p.stdout).text()]);
  return code === 0 ? out.trim() : null;
};

/**
 * Moves the checkout at `dir` to `target` and installs its dependencies. Resolves whether the
 * checkout moved. Throws UpdateError with a reason a person can act on, after putting the
 * checkout back where it was if it had already moved.
 */
export async function updateCheckout(dir: string, target: string, bun: string): Promise<boolean> {
  if (!COMMIT.test(target))
    throw new UpdateError(
      target.endsWith(DIRTY_SUFFIX) && COMMIT.test(target.slice(0, -DIRTY_SUFFIX.length))
        ? `the server runs uncommitted changes (${short(target)}), which no commit holds`
        : `the server's version ${short(target)} is not a git commit, so there is nothing to check out`,
    );
  const c = checkoutOf(dir);
  if (!c)
    throw new UpdateError(`${dir} is not a git checkout; set "update" in the client config to update this install`);
  if (c.dirty)
    throw new UpdateError(
      `${dir} has uncommitted changes; not checking out over them. If they are not yours (an update cut off mid-checkout, say), discard them with: git -C '${dir}' reset -q --hard, or re-run install.sh`,
    );
  if (target.length !== c.commit.length)
    throw new UpdateError(
      `the server's commit is a ${target.length === 64 ? "SHA-256" : "SHA-1"} name but ${dir} uses ${c.commit.length === 64 ? "SHA-256" : "SHA-1"}; it is not a clone of the server's repository`,
    );
  if (c.commit === target) {
    await install(dir, bun);
    return false;
  }
  if (!(await hasCommit(dir, target))) {
    const all = await git(dir, ["fetch", "-q", "origin"]);
    // A commit no branch or tag points at yet: remotes that allow it hand it over by name.
    if (!(await hasCommit(dir, target))) await git(dir, ["fetch", "-q", "origin", target]);
    if (!(await hasCommit(dir, target)))
      throw new UpdateError(
        all.ok
          ? `commit ${short(target)} is not on origin; was it pushed?`
          : `git fetch from origin failed: ${all.err || "no reason given"}`,
      );
  }
  // Where to go back to: the branch if one was checked out, so a later install.sh run finds it as it left it.
  const branch = await gitOut(dir, ["symbolic-ref", "-q", "--short", "HEAD"]);
  const back = branch ?? c.commit;
  const co = await git(dir, ["checkout", "-q", "--detach", target]);
  if (!co.ok) throw new UpdateError(`git checkout ${short(target)} failed: ${co.err}`);
  try {
    await install(dir, bun);
  } catch (e) {
    const undo = await git(dir, ["checkout", "-q", ...(branch ? [] : ["--detach"]), back]);
    const reinstall = undo.ok
      ? await install(dir, bun).then(
          () => null,
          (x: Error) => x.message,
        )
      : null;
    throw new UpdateError(
      `${(e as Error).message}; ${
        undo.ok
          ? `went back to ${short(c.commit)}${reinstall ? `, but reinstalling its dependencies failed too: ${reinstall}` : ""}`
          : `and going back to ${short(c.commit)} failed: ${undo.err}. Re-run install.sh`
      }`,
    );
  }
  return true;
}

/** Installs the dependencies of the code checked out in `dir`. */
async function install(dir: string, bun: string): Promise<void> {
  const pkg = join(dir, "package.json");
  if (!existsSync(pkg)) return;
  let devDeps: string[];
  try {
    devDeps = Object.keys(
      (JSON.parse(readFileSync(pkg, "utf8")) as { devDependencies?: object }).devDependencies ?? {},
    );
  } catch (e) {
    throw new UpdateError(`cannot read ${pkg}: ${(e as Error).message}`);
  }
  // Keep development dependencies in a checkout that has them, so updating a working copy does not break its tooling.
  const dev = devDeps.some((d) => existsSync(join(dir, "node_modules", d)));
  const r = await run([bun, "install", "--cwd", dir, "--frozen-lockfile", ...(dev ? [] : ["--production"])], dir);
  if (!r.ok) throw new UpdateError(`bun install failed: ${r.err}`);
}
