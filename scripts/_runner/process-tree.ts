/**
 * Process-group tracking for the `am-i-done` wall-clock deadline.
 *
 * ## Why a process GROUP and not just the child
 *
 * The failure this exists for is a *grandchild*: `bun test`
 * loses a SIGCHLD, and a leftover worker spins at 97% CPU with a dead event
 * loop. SIGTERM to the direct `bun` process does not reach it — and if the
 * direct child dies first, the spinner is re-parented to init and survives
 * the whole run. Signalling the direct pid is therefore not a kill, it is a
 * pid leak with extra steps.
 *
 * So every child the gate spawns is started `detached: true` — on POSIX that
 * is `setsid(2)`, which makes the child a session AND process-group leader
 * with pgid == pid. Descendants inherit that pgid unless they call setsid
 * themselves (bun's test workers do not), so `kill(-pid, sig)` delivers to
 * the whole tree in one syscall. No `ps` parsing, no descendant walking, no
 * host-wide process hunting — the banned pattern is
 * specifically a *reaper that runs during a healthy run*. This signals only
 * the groups this process itself created, and only once, at the deadline.
 *
 * ## Consequence: signals no longer arrive by terminal
 *
 * A detached child leaves our foreground process group, so a Ctrl-C at the
 * terminal reaches `am-i-done` but NOT its children. `am-i-done.ts` therefore
 * installs SIGINT/SIGTERM handlers that call `killTrackedTree()` — without
 * them, interrupting the gate would strand a full `bun test` fan-out.
 */

/**
 * ## Why Bun.spawn and promises, not node:child_process and events
 *
 * Under load, Bun 1.4.4's `node:child_process` `spawn()` can return a child
 * whose 'exit', 'data', 'end' and 'close' have ALREADY been emitted: when the
 * child exits before the native spawn call finishes, that call runs the
 * nextTick queue (`processTicksAndRejections` under `spawn (native)` in the
 * captured stack), so `#handleOnExit` and the streams' close ticks fire inside
 * `spawn()`, before the caller can attach a single listener. Node never emits
 * synchronously, and listener-based code has no way to notice: the step hung
 * until the 5 s test watchdog, and the `once("close", forget)` that should have
 * deregistered it never ran, so the next file found a stray pid in the set.
 *
 * `runTracked` therefore never subscribes to an event. It awaits `exited` (a
 * promise: a late `await` still sees an exit that already happened) and reads
 * both pipes as ReadableStreams (which buffer until read), and it deregisters
 * in a `finally` on that same promise.
 */

/** How long the tree gets to exit on SIGTERM before SIGKILL follows. */
export const TERM_GRACE_MS = 2_000;
/** How long we wait for the groups to actually disappear after SIGKILL. */
const REAP_VERIFY_MS = 2_000;
/** Liveness poll interval — we test the CONDITION (group gone), not elapsed time. */
const REAP_POLL_MS = 20;

/** Pids (== process-group ids) of children spawned by the gate, still running. */
const tracked = new Set<number>();

export interface TrackedSpawnOptions {
  /** Undefined values are dropped, so callers need no explicit `unset`. */
  env: Record<string, string | undefined>;
  cwd?: string;
  /** Receives stdout as it arrives, decoded as UTF-8. */
  onStdout?: (chunk: string) => void;
  /** Receives stderr as it arrives, decoded as UTF-8. */
  onStderr?: (chunk: string) => void;
}

export interface TrackedExit {
  /** Exit code; null when a signal ended the child or it never started. */
  code: number | null;
  /** Signal name when a signal ended the child. */
  signal: string | null;
  /** Set when the child could not be started at all (ENOENT, EACCES, ...). */
  error?: string;
}

export interface TrackedRun {
  /** Pid (== process-group id); undefined when the spawn itself failed. */
  pid: number | undefined;
  /** Settles once the child has exited AND both pipes have drained. Never rejects. */
  done: Promise<TrackedExit>;
}

/**
 * Run a piped child in its own process group and remember it until it is
 * gone, so a deadline expiry can signal the entire descendant tree.
 */
export function runTracked(cmd: string, args: string[], opts: TrackedSpawnOptions): TrackedRun {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.env)) if (v !== undefined) env[k] = v;

  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn({
      cmd: [cmd, ...args],
      env,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      // setsid: the child leads its own group so kill(-pid) reaches the tree.
      detached: true,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { pid: undefined, done: Promise.resolve({ code: null, signal: null, error }) };
  }

  const pid = proc.pid;
  tracked.add(pid);
  const done = Promise.all([proc.exited, drain(proc.stdout, opts.onStdout), drain(proc.stderr, opts.onStderr)])
    .then(
      (): TrackedExit => ({ code: proc.exitCode, signal: proc.signalCode == null ? null : String(proc.signalCode) }),
    )
    .finally(() => {
      tracked.delete(pid);
    });
  return { pid, done };
}

/** Read a pipe to EOF, handing each decoded chunk to `sink`. */
async function drain(stream: ReadableStream<Uint8Array>, sink?: (chunk: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  try {
    for await (const bytes of stream) {
      const text = decoder.decode(bytes, { stream: true });
      if (text && sink) sink(text);
    }
  } catch (err) {
    // A broken pipe must not settle `done` before the child exits (that would
    // deregister a live group); say so in the output and let `exited` decide.
    sink?.(`[process-tree] pipe read failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const tail = decoder.decode();
  if (tail && sink) sink(tail);
}

/** Pids (== process-group ids) of every child still tracked. Exposed for tests. */
export function trackedPids(): number[] {
  return [...tracked];
}

/** True while any process in `pid`'s group is still running. */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    // ESRCH: the whole group is gone. On macOS a group whose only member is an
    // unreaped zombie answers EPERM (measured); that is gone too.
    return false;
  }
}

function signalGroup(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pid, sig);
  } catch {
    // Group already exited between the liveness check and the signal.
  }
}

async function waitForGroupsGone(pids: number[], budgetMs: number): Promise<void> {
  // Monotonic, not Date.now(): a stepped wall clock would stretch or
  // zero the SIGTERM grace and the post-SIGKILL verification window.
  const deadline = performance.now() + budgetMs;
  while (performance.now() < deadline) {
    if (!pids.some(groupAlive)) return;
    await Bun.sleep(REAP_POLL_MS);
  }
}

export interface KillTreeResult {
  /** Process groups that were signalled. */
  killed: number[];
  /** Groups still alive after SIGKILL + verification window — should always be empty. */
  survivors: number[];
}

/**
 * SIGTERM every tracked process group, wait (condition-based) for them to go,
 * then SIGKILL whatever is left and verify. Returns which groups were signalled
 * and which — if any — refused to die, so the caller can say so out loud rather
 * than claim a clean kill it did not achieve.
 */
export async function killTrackedTree(opts: { graceMs?: number } = {}): Promise<KillTreeResult> {
  const graceMs = opts.graceMs ?? TERM_GRACE_MS;
  const killed = trackedPids();
  if (killed.length === 0) return { killed, survivors: [] };

  for (const pid of killed) signalGroup(pid, "SIGTERM");
  await waitForGroupsGone(killed, graceMs);

  const stubborn = killed.filter(groupAlive);
  for (const pid of stubborn) signalGroup(pid, "SIGKILL");
  await waitForGroupsGone(stubborn, REAP_VERIFY_MS);

  return { killed, survivors: killed.filter(groupAlive) };
}
