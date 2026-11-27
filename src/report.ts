/**
 * The session side of the result contract: `cnoc done`, `fail`, `handoff`, `progress` and `usage`, run by the
 * harness inside a job, and the client-side check of what they send over the local socket.
 */
import type { Outcome, StageResult, Usage } from "./protocol";
import { type HookInput, cleanUsage, collectUsage } from "./usage";

/**
 * `cnoc handoff STATUS`: how the agent left the work, and the stage outcome each status means.
 * Add a status here and it is accepted everywhere.
 */
export const HANDOFF: Record<string, { status: StageResult["status"]; needsMessage: boolean }> = {
  MERGED: { status: "done", needsMessage: false },
  BLOCKED: { status: "failed", needsMessage: true },
};

/** How long `cnoc usage` waits for a hook's JSON on stdin before it uses the environment alone. */
const STDIN_WAIT_MS = 1000;
/** How long a call to the client's local socket may take. */
export const LOCAL_SOCKET_MS = 10_000;

export class ReportError extends Error {}

/** `STATUS [-m MESSAGE]`, with `--message`, `-m=`, and trailing words taken as the message too. */
export function parseHandoff(argv: string[]): { status: StageResult["status"]; handoff: string; summary: string } {
  const words: string[] = [];
  let message: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const eq = /^(-m|--message)=(.*)$/s.exec(a);
    if (eq) message = eq[2] as string;
    else if (a === "-m" || a === "--message") message = argv[++i] ?? "";
    else words.push(a);
  }
  const [raw, ...more] = words;
  const valid = Object.keys(HANDOFF).join(", ");
  if (!raw) throw new ReportError(`missing STATUS: cnoc handoff STATUS [-m "message"], STATUS one of ${valid}`);
  const handoff = raw.toUpperCase();
  const rule = HANDOFF[handoff];
  if (!rule) throw new ReportError(`unknown handoff status ${raw}; use one of ${valid}`);
  const summary = [message, ...more].filter((s) => s !== null && s !== "").join(" ");
  if (rule.needsMessage && !summary) throw new ReportError(`cnoc handoff ${handoff} needs a reason: -m "reason"`);
  return { status: rule.status, handoff, summary: summary || handoff };
}

/** Checks a result that came over the local socket. A string is the reason it was refused. */
export function readResult(body: unknown): StageResult | string {
  const b = (body ?? {}) as Partial<StageResult>;
  if (b.status !== "done" && b.status !== "failed") return "status must be done or failed";
  const out: StageResult = { status: b.status, summary: String(b.summary ?? "") };
  if (b.data !== undefined) out.data = b.data;
  if (b.handoff !== undefined) {
    const h = String(b.handoff).toUpperCase();
    const rule = HANDOFF[h];
    if (!rule) return `unknown handoff status ${b.handoff}; use one of ${Object.keys(HANDOFF).join(", ")}`;
    if (rule.status !== b.status) return `handoff ${h} means ${rule.status}, not ${b.status}`;
    out.handoff = h;
  }
  const usage = cleanUsage(b.usage);
  if (usage) out.usage = usage;
  return out;
}

/**
 * The stage a session command was started under (`CNOC_STAGE`, counted from 1), sent with it so
 * the client can drop one that arrives after its stage is over. A string is why it was refused.
 */
export function wrongStage(body: unknown, current: number): string | null {
  const stage = (body as { stage?: unknown } | null)?.stage;
  if (stage === undefined) return null; // From a session command that predates the field.
  return stage === current ? null : `stage ${String(stage)} is over; this attempt is on stage ${current}`;
}

/**
 * What the changelog carries from an attempt's results: the handoff status of the stage that ended
 * it, and each stage's usage (null where there is none). Fields with nothing to say are left out.
 *
 * The handoff is only the attempt's if its last result is a report whose stage outcome is the
 * attempt's outcome. A later stage that ended without a report leaves no entry, or an unreported
 * one, and an earlier stage's handoff must not stand for it.
 */
export function reportedFields(
  results: StageResult[],
  outcome: Outcome,
): { handoff: { handoff?: string }; usage: { usage?: Array<Usage | null> } } {
  const last = results.at(-1);
  const ended = last?.handoff && last.reported !== false && last.status === outcome ? last.handoff : null;
  const usage = results.some((r) => r.usage) ? { usage: results.map((r) => r.usage ?? null) } : {};
  return { handoff: ended ? { handoff: ended } : {}, usage };
}

/** How long `cnoc done`, `fail` and `handoff` keep trying to reach a client that is not answering: a restart for an update takes about 10 seconds. */
export const REPORT_RETRY_MS = 90_000;
/** How long `cnoc progress` keeps trying. A note is best effort, so it waits out a quick restart and no more. */
export const PROGRESS_RETRY_MS = 15_000;
/** The pause between two tries to reach the client. */
export const RETRY_EVERY_MS = 1_500;
/** Lowers every retry budget, in milliseconds (0: no retry). For tests, and for anyone who would rather fail at once. */
const RETRY_ENV = "CNOC_REPORT_WAIT_MS";

/**
 * The errors that mean the request never reached a client: no socket file, nothing listening on
 * it, or the connection dropped before any answer. An HTTP answer, or a timeout after the request
 * went out, is not one of these, and is final.
 */
const NOT_CONNECTED = new Set([
  "ENOENT",
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "FailedToOpenSocket",
  "ConnectionRefused",
  "ConnectionClosed",
]);
export const notConnected = (e: unknown): boolean => NOT_CONNECTED.has(String((e as { code?: unknown } | null)?.code));

export interface Retry {
  /** Give up once this long has passed since the first try. 0: one try. */
  ms: number;
  everyMs?: number;
  /** Told once, when the first retry starts. */
  waiting?: (line: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
}

/** The retry budget `ms`, lowered by CNOC_REPORT_WAIT_MS when that is set. */
export function retryBudget(ms: number, env: Record<string, string | undefined> = process.env): number {
  const raw = env[RETRY_ENV];
  const cap = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : ms;
  return Math.min(ms, cap);
}

const seconds = (ms: number) => `${Math.round(ms / 1000)}s`;

/**
 * Calls the client's local socket with this attempt's token. With `retry`, a request that could
 * not reach the client (it is restarting, say) is sent again until it does or the time is up. A
 * restarted client serves the same socket path and re-adopts the attempt with the same token, so
 * a retry lands; and a result already taken is answered "already reported", so sending one twice
 * is safe.
 */
export async function local<T>(path: string, body: unknown, retry: Retry = { ms: 0 }): Promise<T> {
  const sock = process.env.CNOC_SOCK;
  const token = process.env.CNOC_TOKEN;
  if (!sock || !token) throw new ReportError("not inside a Cnoc job (CNOC_SOCK is not set)");
  const now = retry.now ?? Date.now;
  const sleep = retry.sleep ?? Bun.sleep;
  const start = now();
  let res: Response | undefined;
  for (let tries = 1; !res; tries++) {
    try {
      res = await fetch(`http://localhost${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        unix: sock,
        signal: AbortSignal.timeout(LOCAL_SOCKET_MS),
      } as RequestInit);
    } catch (e) {
      const spent = now() - start;
      const why = `cannot reach ${sock}: ${(e as Error).message}`;
      // A budget above zero always gets at least one retry, however long the first try took.
      if (!notConnected(e) || retry.ms === 0 || (tries > 1 && spent >= retry.ms))
        throw new ReportError(tries > 1 ? `${why} (still, after ${seconds(spent)} of trying)` : why);
      if (tries === 1)
        retry.waiting?.(
          `cnoc: the cnoc client is not answering (${String((e as { code?: unknown }).code)}); it may be restarting. Trying again for up to ${seconds(retry.ms)}`,
        );
      await sleep(Math.min(retry.everyMs ?? RETRY_EVERY_MS, Math.max(0, retry.ms - spent)));
    }
  }
  const out = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ReportError(out.error ?? `${res.status} ${res.statusText}`);
  return out;
}

const toStderr = (line: string) => console.error(line);

/** `cnoc done`, `cnoc fail` and `cnoc handoff`: the stage's one report, with the session's usage if it can be read. */
export async function report(result: Pick<StageResult, "status" | "summary" | "handoff">): Promise<void> {
  if (!process.env.CNOC_SOCK) throw new ReportError("not inside a Cnoc job (CNOC_SOCK is not set)");
  const usage = await collectUsage();
  const r = await local<{ accepted: boolean }>(
    "/attempt/result",
    { ...result, ...stage(), ...(usage ? { usage } : {}) },
    { ms: retryBudget(REPORT_RETRY_MS), waiting: toStderr },
  );
  const what = result.handoff ? `handoff ${result.handoff} (${result.status})` : result.status;
  console.log(r.accepted ? `reported ${what}` : "a result was already reported for this stage");
}

/** `cnoc progress`: a note for the changelog. Best effort, so it waits only briefly for a client that is restarting. */
export async function progress(note: string): Promise<void> {
  await local("/attempt/progress", { note }, { ms: retryBudget(PROGRESS_RETRY_MS), waiting: toStderr });
}

const stage = (): { stage?: number } => {
  const n = Number(process.env.CNOC_STAGE);
  return Number.isInteger(n) && n > 0 ? { stage: n } : {};
};

async function hookInput(): Promise<HookInput | null> {
  if (process.stdin.isTTY) return null;
  let timer: Timer | undefined;
  const text = await Promise.race([
    Bun.stdin.text(),
    new Promise<string>((r) => {
      timer = setTimeout(() => r(""), STDIN_WAIT_MS);
    }),
  ]).catch(() => "");
  clearTimeout(timer);
  try {
    const o = JSON.parse(text) as HookInput;
    return o && typeof o === "object" ? o : null;
  } catch {
    return null;
  }
}

/**
 * `cnoc usage`: records the session's usage so far without ending the stage. Meant for a Stop
 * hook, so it is silent and always exits 0. `--print` writes what it read to stdout, inside a job or not.
 */
export async function snapshot(print: boolean): Promise<void> {
  try {
    const inside = Boolean(process.env.CNOC_SOCK && process.env.CNOC_TOKEN);
    if (!inside && !print) return;
    const usage = await collectUsage(process.env, await hookInput());
    if (print) console.log(JSON.stringify(usage, null, 2));
    if (usage && inside) await local("/attempt/usage", { usage, ...stage() });
  } catch {
    // A hook that fails or prints is worse than a missing number.
  }
}
