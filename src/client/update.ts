/**
 * Bringing a client to the server's version.
 *
 * The built-in procedure moves the checkout the client runs from to exactly the commit the server
 * names: fetch it from `origin`, check it out detached, install dependencies. It never follows a
 * branch, so a branch that has moved on cannot leave the client one commit short and looping.
 *
 * The commit is only ever an argument to git, never part of a shell string, and it must look like
 * a full object name. The server can choose which commit of the clone's own `origin` to run; it
 * cannot choose where it comes from or run anything that is not a commit there.
 *
 * Every try for one target is recorded in `update.json` in the state directory, so the wait
 * between tries grows across restarts and not only within one process. A new target is tried at
 * once. A client exits for a restart only when that can help: the checkout moved, or the code
 * was already in place but this process may predate it.
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMMIT, DIRTY_SUFFIX, checkoutOf, shortVersion } from "../version";

/** The wait after the first unsuccessful try for a target. It doubles with each further try. */
export const UPDATE_RETRY_BASE_MS = 60_000;
/** The longest wait between two tries for the same target. */
export const UPDATE_RETRY_MAX_MS = 30 * 60_000;
/** One git or bun step may take this long before it is stopped and the try counts as failed. */
const UPDATE_STEP_TIMEOUT_MS = 5 * 60_000;
/** What a version must look like before it is handed to a configured update command. */
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;

/**
 * The `update` command install.sh wrote into every config before updates were built in. It pulls
 * a branch, not the server's commit, so it is ignored in favour of the built-in procedure.
 */
export const LEGACY_UPDATE =
  /^git -C '[^']*' pull -q --ff-only && '[^']*' install --cwd '[^']*' --frozen-lockfile --production$/;

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

  constructor(private o: UpdaterOptions) {
    this.now = o.now ?? Date.now;
    this.command = o.command && !LEGACY_UPDATE.test(o.command) ? o.command : undefined;
    if (o.command && !this.command)
      o.log("the config's update command was written by an older install.sh and is ignored; updates are built in");
  }

  private get file(): string {
    return join(this.o.stateDir, "update.json");
  }

  state(): UpdateState | null {
    try {
      return JSON.parse(readFileSync(this.file, "utf8")) as UpdateState;
    } catch {
      return null; // none yet, or unreadable: either way there is no backoff to honour
    }
  }

  /** The versions agree again: forget past tries. */
  clear(): void {
    if (existsSync(this.file)) rmSync(this.file, { force: true });
  }

  /** Milliseconds until a try for `target` is due; 0 when it is due now. */
  dueIn(target: string): number {
    const s = this.state();
    return s && s.target === target ? Math.max(0, s.next_at - this.now()) : 0;
  }

  /** One line for the server about what this client is doing to reach `target`. */
  note(target: string): string {
    const s = this.state();
    if (this.busy || !s || s.target !== target) return `updating to ${short(target)}`;
    const next = `next try in ${duration(Math.max(0, s.next_at - this.now()))}`;
    if (s.reason) return `update to ${short(target)} failed (try ${s.tries}): ${s.reason}; ${next}`;
    return `restarted for ${short(target)} but still runs ${short(this.o.version)}; ${next}`;
  }

  /**
   * Tries to update to `target` if a try is due and none is running. Resolves true when the
   * client should exit so that its service manager starts the new code.
   */
  async attempt(target: string): Promise<boolean> {
    if (this.busy || this.dueIn(target) > 0) return false;
    this.busy = true;
    try {
      const prev = this.state();
      const same = prev?.target === target ? prev : null;
      const tries = (same?.tries ?? 0) + 1;
      let reason: string | null = null;
      let restart = false;
      try {
        const changed = await this.apply(target);
        // A second restart onto code that is already in place would only loop.
        restart = changed || !same?.restarted;
        if (!restart)
          reason = `the code for ${short(target)} is in place but this client still reports ${short(this.o.version)}; is CNOC_VERSION set?`;
      } catch (e) {
        reason = e instanceof UpdateError ? e.message : `unexpected error: ${(e as Error).message}`;
      }
      const delay = retryDelayMs(tries);
      const now = this.now();
      this.write({
        target,
        tries,
        next_at: now + delay,
        reason,
        restarted: restart || same?.restarted === true,
        at: now,
      });
      this.o.log(
        restart
          ? `server runs ${short(target)}, this client ${short(this.o.version)}: updated; exiting so the service manager starts it`
          : `update to ${short(target)} failed: ${reason}; next try in ${duration(delay)}`,
      );
      return restart;
    } finally {
      this.busy = false;
    }
  }

  private write(s: UpdateState): void {
    writeFileSync(`${this.file}.tmp`, JSON.stringify(s));
    renameSync(`${this.file}.tmp`, this.file);
  }

  private async apply(target: string): Promise<boolean> {
    if (!this.command) return updateCheckout(this.o.checkout, target, this.o.bun ?? process.execPath);
    if (!SAFE_VERSION.test(target)) throw new UpdateError(`refusing to pass version ${JSON.stringify(target)} on`);
    const r = await run(["sh", "-c", this.command], undefined, { CNOC_TARGET_VERSION: target });
    if (!r.ok) throw new UpdateError(`the configured update command failed${r.err ? `: ${r.err}` : ""}`);
    return true;
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
    const last = stderr.trim().split("\n").at(-1)?.trim().slice(0, 200) ?? "";
    return { ok: code === 0, err: p.signalCode ? `stopped (${p.signalCode})` : last };
  } catch (e) {
    return { ok: false, err: (e as Error).message };
  }
}

const git = (dir: string, args: string[]) => run(["git", "-C", dir, ...args]);
const hasCommit = async (dir: string, commit: string) => (await git(dir, ["cat-file", "-e", `${commit}^{commit}`])).ok;

/**
 * Moves the checkout at `dir` to `target` and installs its dependencies. Resolves whether the
 * checkout moved. Throws UpdateError with a reason a person can act on.
 */
export async function updateCheckout(dir: string, target: string, bun: string): Promise<boolean> {
  if (!COMMIT.test(target))
    throw new UpdateError(
      target.endsWith(DIRTY_SUFFIX)
        ? `the server runs uncommitted changes (${short(target)}), which no commit holds`
        : `the server's version ${JSON.stringify(target.slice(0, 80))} is not a git commit, so there is nothing to check out`,
    );
  const c = checkoutOf(dir);
  if (!c)
    throw new UpdateError(`${dir} is not a git checkout; set "update" in the client config to update this install`);
  if (c.dirty) throw new UpdateError(`${dir} has uncommitted changes; not checking out over them`);
  let changed = false;
  if (c.commit !== target) {
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
    const co = await git(dir, ["checkout", "-q", "--detach", target]);
    if (!co.ok) throw new UpdateError(`git checkout ${short(target)} failed: ${co.err}`);
    changed = true;
  }
  const pkg = join(dir, "package.json");
  if (existsSync(pkg)) {
    // Keep development dependencies in a checkout that has them, so updating a working copy does not break its tooling.
    const devDeps = Object.keys(
      (JSON.parse(readFileSync(pkg, "utf8")) as { devDependencies?: object }).devDependencies ?? {},
    );
    const dev = devDeps.some((d) => existsSync(join(dir, "node_modules", d)));
    const r = await run([bun, "install", "--cwd", dir, "--frozen-lockfile", ...(dev ? [] : ["--production"])], dir);
    if (!r.ok) throw new UpdateError(`bun install failed: ${r.err}`);
  }
  return changed;
}
