/**
 * `cnoc feed`: turn a backlog into jobs without cnoc knowing what a backlog is.
 *
 * A source command the operator supplies prints one template run per line, as JSON. Every line is
 * submitted as a keyed run (`keyed: true`), so the server answers "already there" for an item it has
 * seen and the feeder needs no state of its own: it offers the whole backlog every pass, and only
 * new items become jobs.
 *
 * The HTTP call is injected, so this module is tested without a server.
 */
import { JobfileError, parseDuration } from "./jobfile";
import type { Overrides } from "./protocol";

/** How long the source command may run before its whole process group is stopped. */
export const SOURCE_TIMEOUT_MS = 120_000;
/** How long the source's process group gets to exit on SIGTERM before SIGKILL follows. */
const SOURCE_KILL_GRACE_MS = 2_000;
/** How long to wait for the group to disappear after SIGKILL. */
const SOURCE_REAP_MS = 2_000;
/** How often to look again while waiting for the group to go. */
const REAP_POLL_MS = 20;
/** New jobs per pass when `--max` is not given. */
export const DEFAULT_MAX = 10;
/** Lines of the source's stderr repeated in the log. */
const STDERR_LINES = 20;

export const FEED_HELP = `cnoc feed [--every DURATION] [--max N] [--dry-run] -- COMMAND [ARGS...]

Runs COMMAND (directly, no shell) and submits each line it prints as a keyed template run:
  {"template":"lane","key":"myapp-1234","set":{"PROJECT":"myapp","ISSUE":"1234"},"priority":5,"on":"workbox","begin":"+2h"}
"template" (a name or number) is required. "key" is needed unless the template declares one.
"set" values are strings or numbers. "priority", "on" and "begin" are as for cnoc template run.
A run whose key already exists is left alone, so the whole backlog can be offered every pass.

  --every DURATION   repeat forever, one pass at a time (90s, 5m, 1h); without it, one pass then exit,
                     non-zero if COMMAND failed or any line was rejected
  --max N            at most N new jobs per pass (default ${DEFAULT_MAX}); the rest wait for the next pass
  --dry-run          print the runs that would be offered, submit nothing

COMMAND gets ${SOURCE_TIMEOUT_MS / 1000} seconds. If it fails or times out, nothing from that pass is submitted.`;

/** What `POST /v1/template/run` is sent. */
export interface RunRequest {
  set: Record<string, string>;
  overrides: Overrides;
  key?: string;
  /** Always true: the server refuses a run with no key, so a pass can never mint a fresh job. */
  keyed: true;
}

/** What the server answers to a run. `created` and `state` come with keyed runs. */
export interface RunAnswer {
  job: { id: string; state: string };
  created?: boolean;
  state?: string;
}

/**
 * Submits one run. A refusal of that one run (bad arguments, unknown template or host) must reject
 * with an error whose `status` is 400, 404, 409 or 422; the line is then reported and the pass goes
 * on. Anything else (no connection, a bad token, a server error) stops the pass.
 */
export type SubmitRun = (ref: string, body: RunRequest) => Promise<RunAnswer>;

/** One valid line of the source's output. */
export interface FeedLine {
  line: number;
  ref: string;
  body: RunRequest;
}

export interface FeedOptions {
  command: string[];
  /** Seconds between pass starts; absent for a single pass. */
  everyS?: number;
  max: number;
  dryRun: boolean;
}

export interface FeedDeps {
  submit: SubmitRun;
  /** One line of normal output. */
  log: (line: string) => void;
  /** One line about something that went wrong. */
  warn: (line: string) => void;
  /** Stops a looping feeder, and a running source command with it. */
  signal?: AbortSignal;
  /** Defaults to SOURCE_TIMEOUT_MS. */
  timeoutMs?: number;
}

export interface PassResult {
  created: number;
  existing: number;
  rejected: number;
  heldBack: number;
  /** Set when the source command failed or the pass was cut short. */
  failure?: string;
}

/** The server cannot honour keyed runs; carrying on would create a new job every pass. */
export class FeedFatal extends Error {}
class FeedUsage extends Error {}

const LINE_FIELDS = new Set(["template", "key", "set", "priority", "on", "begin"]);
const REFUSALS = new Set([400, 404, 409, 422]);
const PREFIX = "[feed]";

/** Parses `cnoc feed`'s arguments: options, then `--`, then the command. */
export function parseFeedArgs(argv: string[]): FeedOptions {
  const sep = argv.indexOf("--");
  const own = sep < 0 ? argv : argv.slice(0, sep);
  const command = sep < 0 ? [] : argv.slice(sep + 1);
  const out: FeedOptions = { command, max: DEFAULT_MAX, dryRun: false };
  for (let i = 0; i < own.length; i++) {
    const a = own[i] as string;
    const eq = a.indexOf("=");
    const [flag, inline] = eq < 0 ? [a, undefined] : [a.slice(0, eq), a.slice(eq + 1)];
    const value = (): string => {
      const v = inline ?? own[++i];
      if (v === undefined) throw new FeedUsage(`${flag} needs a value`);
      return v;
    };
    if (flag === "--dry-run") out.dryRun = true;
    else if (flag === "--every") {
      try {
        out.everyS = parseDuration(value());
      } catch (e) {
        if (!(e instanceof JobfileError)) throw e;
        throw new FeedUsage(`--every: ${e.message}; use 90s, 5m or 1h`);
      }
    } else if (flag === "--max") {
      const v = value();
      out.max = Number(v);
      if (!/^\d+$/.test(v) || out.max < 1) throw new FeedUsage(`--max takes a whole number of at least 1, got ${v}`);
    } else throw new FeedUsage(`unknown option ${a}; put the command after --`);
  }
  if (command.length === 0) throw new FeedUsage("missing COMMAND; give it after --");
  return out;
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Reads one line of the source's output. Returns null for a blank line and a string for a bad one. */
export function parseFeedLine(text: string, line: number): FeedLine | string | null {
  if (text.trim() === "") return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    return `not JSON (${(e as Error).message})`;
  }
  if (!isPlain(v)) return "not a JSON object";
  for (const k of Object.keys(v)) if (!LINE_FIELDS.has(k)) return `unknown field ${JSON.stringify(k)}`;
  const { template, key, set, priority, on, begin } = v;
  let ref: string;
  if (typeof template === "string" && template.trim() !== "") ref = template;
  else if (typeof template === "number" && Number.isInteger(template) && template > 0) ref = String(template);
  else return `"template" must be a name or a number, got ${JSON.stringify(template)}`;
  const body: RunRequest = { set: {}, overrides: {}, keyed: true };
  if (key !== undefined) {
    if (typeof key !== "string" || key === "") return `"key" must be a non-empty string`;
    body.key = key;
  }
  if (set !== undefined) {
    if (!isPlain(set)) return `"set" must be an object of NAME: value`;
    for (const [name, val] of Object.entries(set)) {
      if (typeof val === "string") body.set[name] = val;
      else if (typeof val === "number" && Number.isFinite(val)) body.set[name] = String(val);
      else return `"set.${name}" must be a string or a number`;
    }
  }
  if (priority !== undefined) {
    if (typeof priority !== "number" || !Number.isInteger(priority)) return `"priority" must be a whole number`;
    body.overrides.priority = priority;
  }
  if (on !== undefined) {
    if (typeof on !== "string" || on === "") return `"on" must be a host name`;
    body.overrides.on = on;
  }
  if (begin !== undefined) {
    if (typeof begin !== "string" || begin === "") return `"begin" must be a time with a zone or a delay such as +2h`;
    body.overrides.begin = begin;
  }
  return { line, ref, body };
}

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

/** Stops the source's whole process group: SIGTERM, then SIGKILL for whatever ignored it. */
async function stopGroup(pid: number): Promise<void> {
  signalGroup(pid, "SIGTERM");
  if (await waitGone(pid, SOURCE_KILL_GRACE_MS)) return;
  signalGroup(pid, "SIGKILL");
  await waitGone(pid, SOURCE_REAP_MS);
}

export interface SourceOutput {
  stdout: string;
  stderr: string;
  /** Why the output cannot be used; absent on success. */
  failure?: string;
}

/**
 * Runs the source command in its own process group (so a timeout reaches its children too) and
 * returns what it printed. A non-zero exit, a signal or a timeout is a failure.
 */
export async function runSource(command: string[], timeoutMs: number, signal?: AbortSignal): Promise<SourceOutput> {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn({ cmd: command, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true });
  } catch (e) {
    return { stdout: "", stderr: "", failure: `cannot start ${command[0]}: ${(e as Error).message}` };
  }
  const pid = proc.pid;
  let stopped: string | undefined;
  let stopping: Promise<void> | undefined;
  const stop = (why: string) => {
    stopped ??= why;
    stopping ??= stopGroup(pid);
  };
  const timer = setTimeout(() => stop(`timed out after ${timeoutMs / 1000}s`), timeoutMs);
  const onAbort = () => stop("stopped");
  signal?.addEventListener("abort", onAbort);
  if (signal?.aborted) onAbort();
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (stopping) await stopping;
    const failure =
      stopped ??
      (proc.exitCode !== 0
        ? proc.exitCode === null
          ? `ended by ${proc.signalCode}`
          : `exited with status ${proc.exitCode}`
        : undefined);
    return { stdout, stderr, ...(failure ? { failure } : {}) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

const isRefusal = (e: unknown): boolean => {
  const status = (e as { status?: unknown } | null)?.status;
  return typeof status === "number" && REFUSALS.has(status);
};

const describe = (l: FeedLine): string => {
  const parts = [l.ref, ...(l.body.key ? [`key ${l.body.key}`] : [])];
  for (const [k, v] of Object.entries(l.body.set)) parts.push(`${k}=${v}`);
  for (const [k, v] of Object.entries(l.body.overrides)) parts.push(`${k} ${v}`);
  return parts.join(" ");
};

/** One pass: run the source, then offer every valid line, stopping after `max` new jobs. */
export async function feedPass(opts: FeedOptions, deps: FeedDeps): Promise<PassResult> {
  const result: PassResult = { created: 0, existing: 0, rejected: 0, heldBack: 0 };
  const out = await runSource(opts.command, deps.timeoutMs ?? SOURCE_TIMEOUT_MS, deps.signal);
  const errLines = out.stderr.split("\n").filter((l) => l.trim() !== "");
  for (const l of errLines.slice(-STDERR_LINES)) deps.warn(`${PREFIX} source: ${l}`);
  if (out.failure) {
    result.failure = `command ${out.failure}`;
    deps.warn(`${PREFIX} command ${out.failure}; nothing submitted this pass`);
    return result;
  }
  const lines: FeedLine[] = [];
  for (const [i, text] of out.stdout.replace(/\n$/, "").split("\n").entries()) {
    const parsed = parseFeedLine(text.replace(/\r$/, ""), i + 1);
    if (parsed === null) continue;
    if (typeof parsed === "string") {
      result.rejected++;
      deps.warn(`${PREFIX} line ${i + 1} rejected: ${parsed}`);
    } else lines.push(parsed);
  }
  if (opts.dryRun) {
    for (const l of lines) deps.log(`${PREFIX} would offer line ${l.line}: ${describe(l)}`);
    deps.log(`${PREFIX} dry run: ${lines.length} would be offered, ${result.rejected} rejected`);
    return result;
  }
  for (const [i, l] of lines.entries()) {
    if (result.created >= opts.max) {
      result.heldBack = lines.length - i;
      break;
    }
    let r: RunAnswer;
    try {
      r = await deps.submit(l.ref, l.body);
    } catch (e) {
      if (!isRefusal(e)) {
        result.failure = (e as Error).message;
        deps.warn(`${PREFIX} pass stopped at line ${l.line}: ${result.failure}`);
        break;
      }
      result.rejected++;
      deps.warn(`${PREFIX} line ${l.line} rejected by the server: ${(e as Error).message}`);
      continue;
    }
    if (typeof r.created !== "boolean")
      throw new FeedFatal(
        `the server did not say whether ${r.job?.id ?? "the job"} is new, so it does not support keyed runs; stopping before every pass creates another job`,
      );
    if (r.created) {
      result.created++;
      deps.log(`${PREFIX} created ${r.job.id} (${r.state ?? r.job.state})`);
    } else result.existing++;
  }
  const held = result.heldBack ? `, ${result.heldBack} held back by --max ${opts.max}` : "";
  const line = `${PREFIX} pass: ${result.created} created, ${result.existing} already there, ${result.rejected} rejected${held}`;
  (result.failure ? deps.warn : deps.log)(result.failure ? `${line} (stopped early)` : line);
  return result;
}

const pause = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((done) => {
    if (signal?.aborted) return done();
    const t = setTimeout(finish, ms);
    function finish() {
      clearTimeout(t);
      signal?.removeEventListener("abort", finish);
      done();
    }
    signal?.addEventListener("abort", finish);
  });

/**
 * Runs the feeder and returns the exit status. A single pass is 1 if the command failed or any
 * line was rejected. A loop runs until `signal` aborts, logging failures and carrying on; only a
 * server without keyed runs ends it, with 1.
 */
export async function feed(opts: FeedOptions, deps: FeedDeps): Promise<number> {
  try {
    if (opts.everyS === undefined) {
      const r = await feedPass(opts, deps);
      return r.failure || r.rejected ? 1 : 0;
    }
    deps.log(`${PREFIX} every ${opts.everyS}s, at most ${opts.max} new jobs a pass: ${opts.command.join(" ")}`);
    while (!deps.signal?.aborted) {
      const started = performance.now();
      await feedPass(opts, deps);
      await pause(Math.max(0, opts.everyS * 1000 - (performance.now() - started)), deps.signal);
    }
    return 0;
  } catch (e) {
    if (!(e instanceof FeedFatal)) throw e;
    deps.warn(`${PREFIX} ${e.message}`);
    return 1;
  }
}

/** The `cnoc feed` command: parses its arguments, stops cleanly on SIGINT and SIGTERM. */
export async function feedCommand(argv: string[], submit: SubmitRun): Promise<number> {
  const own = argv.includes("--") ? argv.slice(0, argv.indexOf("--")) : argv;
  if (own.includes("--help") || own.includes("-h")) {
    console.log(FEED_HELP);
    return 0;
  }
  let opts: FeedOptions;
  try {
    opts = parseFeedArgs(argv);
  } catch (e) {
    if (!(e instanceof FeedUsage)) throw e;
    console.error(`cnoc feed: ${e.message}\n\n${FEED_HELP}`);
    return 2;
  }
  const stop = new AbortController();
  const onSignal = () => stop.abort();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    return await feed(opts, {
      submit,
      log: (l) => console.log(l),
      warn: (l) => console.error(l),
      signal: stop.signal,
    });
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
