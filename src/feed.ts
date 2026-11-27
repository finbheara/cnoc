/**
 * `cnoc feed`: turn a backlog into jobs without cnoc knowing what a backlog is.
 *
 * A source command the operator supplies prints one template run per line, as JSON. Every line is
 * submitted as a keyed run (`keyed: true`), so the server answers "already there" for an item it has
 * seen and the feeder needs no state of its own: it offers the whole backlog every pass, and only
 * new items become jobs.
 *
 * The server calls are injected, so this module is tested without a server.
 */
import { SOURCE_LIMITS, SOURCE_MAX_BYTES, SOURCE_MAX_LINES, type SourceLimits, runSource } from "./feed-source";
import { ARG_NAME_RE, JobfileError, parseDuration } from "./jobfile";
import type { Overrides } from "./protocol";

/** New jobs per pass when `--max` is not given. */
export const DEFAULT_MAX = 10;
/** How long one request to the server may take. */
export const REQUEST_TIMEOUT_MS = 30_000;
/** Exit status for a condition that will not fix itself (EX_CONFIG); a service manager should not restart. */
export const EXIT_FATAL = 78;
/** What `/v1/health` lists when the server does keyed template runs. */
export const KEYED_RUNS_FEATURE = "keyed-runs";
/** Lines of the source's stderr repeated in the log. */
const STDERR_LINES = 20;

export const FEED_HELP = `cnoc feed [--every DURATION] [--max N] [--dry-run] -- COMMAND [ARGS...]

Runs COMMAND (directly, no shell) and submits each line it prints as a keyed template run:
  {"template":"lane","key":"myapp-1234","set":{"PROJECT":"myapp","ISSUE":"1234"},"priority":5,"on":"workbox","begin":"+2h"}
"template" (a name or number) is required. "key" is needed unless the template declares one.
"set" values are strings, or whole numbers up to 2^53. "priority", "on" and "begin" are as for
cnoc template run. A null field is the same as one left out. A key may not be all digits: use
myapp-1234, not 1234. A run whose key already exists is left alone, so the whole backlog can be
offered every pass.

  --every DURATION   repeat forever, one pass at a time (90s, 5m, 1h); without it, one pass then exit,
                     1 if COMMAND failed or any line was rejected
  --max N            at most N new jobs per pass (default ${DEFAULT_MAX}); the rest wait for the next pass
  --dry-run          print the runs that would be offered, submit nothing

COMMAND gets ${SOURCE_LIMITS.timeoutMs / 1000} seconds, ${SOURCE_MAX_LINES} lines and ${SOURCE_MAX_BYTES / 1024 / 1024} MiB of output. If it fails,
times out or prints more, nothing from that pass is submitted. It does not get CNOC_TOKEN.
Exits ${EXIT_FATAL} when carrying on cannot help: the server lacks keyed runs, or refuses the token.`;

/** What `POST /v1/template/run` is sent. */
export interface RunRequest {
  set: Record<string, string>;
  overrides: Overrides;
  key?: string;
  /** Always true: the server refuses a run with no key, so a pass can never mint a fresh job. */
  keyed: true;
}

/**
 * The two server calls, each given a signal that aborts on a stop or after REQUEST_TIMEOUT_MS.
 * A call that the server answers with an error must reject with an error carrying `status`:
 * 400, 404, 409 or 422 refuse that one line; 401 or 403 stop the feeder; anything else, or no
 * status, stops the pass.
 */
export interface FeedServer {
  /** `GET /v1/health`. */
  health(signal: AbortSignal): Promise<unknown>;
  /** `POST /v1/template/run?ref=`. */
  run(ref: string, body: RunRequest, signal: AbortSignal): Promise<unknown>;
}

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
  server: FeedServer;
  /** One line of normal output. */
  log: (line: string) => void;
  /** One line about something that went wrong. */
  warn: (line: string) => void;
  /** Stops the feeder, a running source command and a request in flight. */
  signal?: AbortSignal;
  /** Defaults to SOURCE_LIMITS. */
  limits?: SourceLimits;
  /** Defaults to REQUEST_TIMEOUT_MS. */
  requestTimeoutMs?: number;
}

export interface PassResult {
  created: number;
  existing: number;
  rejected: number;
  heldBack: number;
  /** Set when the source command failed or the pass was cut short. */
  failure?: string;
}

/** Carrying on cannot help: the server lacks keyed runs or refuses the token. Exits EXIT_FATAL. */
export class FeedFatal extends Error {}
class FeedUsage extends Error {}

const LINE_FIELDS = new Set(["template", "key", "set", "priority", "on", "begin"]);
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
  // null is the same as absent, as it is for the server.
  const opt = (k: string): unknown => v[k] ?? undefined;
  const { template } = v;
  const [key, set, priority, on, begin] = ["key", "set", "priority", "on", "begin"].map(opt);
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
      if (!ARG_NAME_RE.test(name)) return `"set" name ${JSON.stringify(name)} is not an ARG name (capitals, digits, _)`;
      if (typeof val === "string") body.set[name] = val;
      else if (typeof val === "number" && Number.isSafeInteger(val)) body.set[name] = String(val);
      else if (typeof val === "number")
        return `"set.${name}" is a number JSON cannot carry exactly; send it as a string`;
      else return `"set.${name}" must be a string or a whole number`;
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

const statusOf = (e: unknown): number | undefined => {
  const status = (e as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
};
const REFUSALS = new Set([400, 404, 409, 422]);
const FATAL_STATUS = new Set([401, 403]);

/** Raises FeedFatal for an error that will not go away by trying again. */
function fatalIfAuth(e: unknown): void {
  const status = statusOf(e);
  if (status !== undefined && FATAL_STATUS.has(status))
    throw new FeedFatal(`the server refused the token (${status}): ${(e as Error).message}`);
}

const describe = (l: FeedLine): string => {
  const parts = [l.ref, ...(l.body.key ? [`key ${l.body.key}`] : [])];
  for (const [k, v] of Object.entries(l.body.set)) parts.push(`${k}=${v}`);
  for (const [k, v] of Object.entries(l.body.overrides)) parts.push(`${k} ${v}`);
  return parts.join(" ");
};

/** A call to the server that gives up on a stop or after the request timeout. */
async function call<T>(deps: FeedDeps, f: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const timeoutMs = deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout;
  // Raced against the signal too, so a call that ignores its signal still cannot hold the feeder.
  let onAbort = () => {};
  const aborted = new Promise<never>((_, fail) => {
    onAbort = () => fail(new Error("aborted"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => {});
  try {
    return await Promise.race([f(signal), aborted]);
  } catch (e) {
    if (timeout.aborted) throw new Error(`no answer from the server in ${timeoutMs / 1000}s`);
    if (deps.signal?.aborted) throw new Error("stopped");
    throw e;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Asks the server whether it does keyed runs. Without them every run would be a new numbered job,
 * so the feeder refuses to submit anything; it asks before its first submission.
 */
async function checkKeyedRuns(deps: FeedDeps): Promise<void> {
  const health = await call(deps, (signal) => deps.server.health(signal));
  const features = (health as { features?: unknown } | null)?.features;
  if (!Array.isArray(features) || !features.includes(KEYED_RUNS_FEATURE))
    throw new FeedFatal(
      "the server does not do keyed template runs, so every run would be a new job; upgrade the server",
    );
}

/** Checks a run's answer and returns the job's id, its state and whether it is new. */
function readAnswer(r: unknown): { id: string; state: string; created: boolean } {
  const a = r as { job?: { id?: unknown; state?: unknown } | null; created?: unknown; state?: unknown } | null;
  const id = a?.job?.id;
  const state = a?.state ?? a?.job?.state;
  if (typeof id !== "string" || typeof state !== "string")
    throw new Error(`the server's answer has no job: ${JSON.stringify(r)?.slice(0, 200)}`);
  if (typeof a?.created !== "boolean")
    throw new FeedFatal(
      `the server did not say whether ${id} is new, so it does not do keyed runs; stopping before every pass creates another job`,
    );
  return { id, state, created: a.created };
}

/** State kept across passes: whether the server has been seen to do keyed runs. */
interface FeedState {
  keyedRuns: boolean;
}

/** One pass: run the source, then offer every valid line, stopping after `max` new jobs. */
export async function feedPass(
  opts: FeedOptions,
  deps: FeedDeps,
  state: FeedState = { keyedRuns: false },
): Promise<PassResult> {
  const result: PassResult = { created: 0, existing: 0, rejected: 0, heldBack: 0 };
  const out = await runSource(opts.command, deps.limits ?? SOURCE_LIMITS, deps.signal);
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
  const stopPass = (why: string, line?: number) => {
    result.failure = why;
    deps.warn(`${PREFIX} pass stopped${line === undefined ? "" : ` at line ${line}`}: ${why}`);
  };
  if (lines.length && !state.keyedRuns) {
    try {
      await checkKeyedRuns(deps);
      state.keyedRuns = true;
    } catch (e) {
      if (e instanceof FeedFatal) throw e;
      fatalIfAuth(e);
      stopPass(`cannot ask the server what it supports: ${(e as Error).message}`);
    }
  }
  for (const [i, l] of result.failure ? [] : lines.entries()) {
    if (deps.signal?.aborted) {
      stopPass("stopped", l.line);
      break;
    }
    if (result.created >= opts.max) {
      result.heldBack = lines.length - i;
      break;
    }
    let r: { id: string; state: string; created: boolean };
    try {
      r = readAnswer(await call(deps, (signal) => deps.server.run(l.ref, l.body, signal)));
    } catch (e) {
      if (e instanceof FeedFatal) throw e;
      fatalIfAuth(e);
      const status = statusOf(e);
      if (status === undefined || !REFUSALS.has(status)) {
        stopPass((e as Error).message, l.line);
        break;
      }
      result.rejected++;
      deps.warn(`${PREFIX} line ${l.line} rejected by the server: ${(e as Error).message}`);
      continue;
    }
    if (r.created) {
      result.created++;
      deps.log(`${PREFIX} created ${r.id} (${r.state})`);
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
 * line was rejected. A loop runs until `signal` aborts, logging failures and carrying on. Either
 * ends with EXIT_FATAL when the server lacks keyed runs or refuses the token.
 */
export async function feed(opts: FeedOptions, deps: FeedDeps): Promise<number> {
  const state: FeedState = { keyedRuns: false };
  try {
    if (opts.everyS === undefined) {
      const r = await feedPass(opts, deps, state);
      return r.failure || r.rejected ? 1 : 0;
    }
    deps.log(`${PREFIX} every ${opts.everyS}s, at most ${opts.max} new jobs a pass: ${opts.command.join(" ")}`);
    while (!deps.signal?.aborted) {
      const started = performance.now();
      await feedPass(opts, deps, state);
      await pause(Math.max(0, opts.everyS * 1000 - (performance.now() - started)), deps.signal);
    }
    return 0;
  } catch (e) {
    if (!(e instanceof FeedFatal)) throw e;
    deps.warn(`${PREFIX} ${e.message}; not retrying (exit ${EXIT_FATAL})`);
    return EXIT_FATAL;
  }
}

/**
 * The `cnoc feed` command. The first SIGINT or SIGTERM stops the command and any request in flight
 * and ends the feeder after the pass; a second one exits at once.
 */
export async function feedCommand(argv: string[], server: FeedServer): Promise<number> {
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
  const onSignal = (sig: NodeJS.Signals) => {
    if (stop.signal.aborted) process.exit(sig === "SIGINT" ? 130 : 143);
    console.error(`${PREFIX} ${sig}: stopping; send it again to exit at once`);
    stop.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    return await feed(opts, {
      server,
      log: (l) => console.log(l),
      warn: (l) => console.error(l),
      signal: stop.signal,
    });
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
