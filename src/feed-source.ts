/**
 * Runs the source command of `cnoc feed` and collects what it prints, with bounds on time and size.
 *
 * The command leads its own process group (`detached: true` is setsid), so a stop reaches every
 * descendant that stayed in the group. A descendant that starts its own session leaves the group and
 * cannot be signalled from here; if it holds the output pipes open, the reads are given up after
 * a short grace instead, so a pass is bounded by the time limit whatever the command does.
 */

/** How long the source command may run before its process group is stopped. */
export const SOURCE_TIMEOUT_MS = 120_000;
/** Most bytes of stdout read from the source; more is a failure. */
export const SOURCE_MAX_BYTES = 16 * 1024 * 1024;
/** Most lines read from the source; more is a failure. */
export const SOURCE_MAX_LINES = 10_000;
/** How much of the end of the source's stderr is kept for the log. */
const STDERR_TAIL_BYTES = 8 * 1024;
/** How long the process group gets to exit on SIGTERM before SIGKILL follows. */
const SOURCE_KILL_GRACE_MS = 2_000;
/** How long to wait for the group to disappear after SIGKILL. */
const SOURCE_REAP_MS = 2_000;
/** After a stop, how long the output pipes may stay open before the reads are abandoned. */
const SOURCE_DRAIN_MS = 1_000;
/** How often to look again while waiting for the group to go. */
const REAP_POLL_MS = 20;

export interface SourceLimits {
  timeoutMs: number;
  maxBytes: number;
  maxLines: number;
}
export const SOURCE_LIMITS: SourceLimits = {
  timeoutMs: SOURCE_TIMEOUT_MS,
  maxBytes: SOURCE_MAX_BYTES,
  maxLines: SOURCE_MAX_LINES,
};

export interface SourceOutput {
  stdout: string;
  /** The last few kilobytes of stderr. */
  stderr: string;
  /** Why the output cannot be used; absent on success. */
  failure?: string;
}

/** Names the source command never sees: the feeder's credential and the job socket. */
const WITHHELD_ENV = ["CNOC_TOKEN", "CNOC_SOCK"];

const groupAlive = (pid: number): boolean => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    // ESRCH: the group is gone. On macOS a group of only unreaped zombies answers EPERM; gone too.
    return false;
  }
};

const signalGroup = (pid: number, sig: NodeJS.Signals): void => {
  try {
    process.kill(-pid, sig);
  } catch {
    // The group exited between the check and the signal.
  }
};

async function waitGone(pid: number, ms: number): Promise<boolean> {
  const end = performance.now() + ms;
  while (groupAlive(pid)) {
    if (performance.now() > end) return false;
    await Bun.sleep(REAP_POLL_MS);
  }
  return true;
}

/** Stops the process group: SIGTERM, then SIGKILL for whatever ignored it. */
async function stopGroup(pid: number): Promise<void> {
  if (!groupAlive(pid)) return;
  signalGroup(pid, "SIGTERM");
  if (await waitGone(pid, SOURCE_KILL_GRACE_MS)) return;
  signalGroup(pid, "SIGKILL");
  await waitGone(pid, SOURCE_REAP_MS);
}

const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/**
 * Runs `command` and returns what it printed. A non-zero exit, a signal, a timeout, an abort or
 * output over the limits is a failure. Anything left running in the group afterwards is stopped.
 */
export async function runSource(
  command: string[],
  limits: SourceLimits = SOURCE_LIMITS,
  signal?: AbortSignal,
): Promise<SourceOutput> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of WITHHELD_ENV) delete env[k];
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn({ cmd: command, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true });
  } catch (e) {
    return { stdout: "", stderr: "", failure: `cannot start ${command[0]}: ${(e as Error).message}` };
  }
  const pid = proc.pid;

  let stopped: string | undefined;
  let stopDone: Promise<void> | undefined;
  let onStopped: () => void = () => {};
  const whenStopped = new Promise<void>((done) => {
    onStopped = done;
  });
  const stop = (why: string) => {
    if (stopped) return;
    stopped = why;
    stopDone = stopGroup(pid).then(onStopped);
  };

  const out: Uint8Array[] = [];
  let bytes = 0;
  let lines = 0;
  let errTail = "";
  const decoder = new TextDecoder();
  const outReader = proc.stdout.getReader();
  const errReader = proc.stderr.getReader();
  const readOut = (async () => {
    for (;;) {
      const { done, value } = await outReader.read();
      if (done || stopped) return;
      bytes += value.length;
      for (const b of value) if (b === 10) lines++;
      if (bytes > limits.maxBytes) return stop(`printed more than ${limits.maxBytes} bytes`);
      if (lines > limits.maxLines) return stop(`printed more than ${limits.maxLines} lines`);
      out.push(value);
    }
  })();
  const readErr = (async () => {
    for (;;) {
      const { done, value } = await errReader.read();
      if (done) return;
      errTail = (errTail + decoder.decode(value, { stream: true })).slice(-STDERR_TAIL_BYTES);
    }
  })();

  const timer = setTimeout(() => stop(`timed out after ${limits.timeoutMs / 1000}s`), limits.timeoutMs);
  const onAbort = () => stop("stopped");
  signal?.addEventListener("abort", onAbort);
  if (signal?.aborted) onAbort();
  const finished = Promise.all([readOut, readErr, proc.exited]);
  try {
    await Promise.race([finished, whenStopped]);
    if (stopped) {
      // Whatever still holds the pipes is outside the group; stop waiting for it.
      await Promise.race([finished, delay(SOURCE_DRAIN_MS)]);
      await Promise.all([outReader.cancel(), errReader.cancel()]);
    } else {
      // A background process the command left behind is stopped, so passes do not leak them.
      await stopGroup(pid);
    }
    if (stopDone) await stopDone;
    const failure =
      stopped ??
      (proc.exitCode === 0
        ? undefined
        : proc.exitCode === null
          ? `ended by ${proc.signalCode}`
          : `exited with status ${proc.exitCode}`);
    const stdout = failure ? "" : new TextDecoder().decode(Buffer.concat(out));
    return { stdout, stderr: errTail, ...(failure ? { failure } : {}) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
