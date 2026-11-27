/**
 * The session side of the result contract: `cnoc done`, `fail`, `handoff` and `usage`, run by the
 * harness inside a job, and the client-side check of what they send over the local socket.
 */
import type { StageResult, Usage } from "./protocol";
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
 * What the changelog carries from an attempt's results: the handoff status of the stage that ended
 * it, and each stage's usage (null where there is none). Fields with nothing to say are left out.
 */
export function reportedFields(results: StageResult[]): {
  handoff: { handoff?: string };
  usage: { usage?: Array<Usage | null> };
} {
  const last = results.at(-1)?.handoff;
  const usage = results.some((r) => r.usage) ? { usage: results.map((r) => r.usage ?? null) } : {};
  return { handoff: last ? { handoff: last } : {}, usage };
}

/** Calls the client's local socket with this attempt's token. */
async function local<T>(path: string, body: unknown): Promise<T> {
  const sock = process.env.CNOC_SOCK;
  const token = process.env.CNOC_TOKEN;
  if (!sock || !token) throw new ReportError("not inside a Cnoc job (CNOC_SOCK is not set)");
  const res = await fetch(`http://localhost${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    unix: sock,
  } as RequestInit).catch((e: Error) => {
    throw new ReportError(`cannot reach ${sock}: ${e.message}`);
  });
  const out = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ReportError(out.error ?? `${res.status} ${res.statusText}`);
  return out;
}

/** `cnoc done`, `cnoc fail` and `cnoc handoff`: the stage's one report, with the session's usage if it can be read. */
export async function report(result: Pick<StageResult, "status" | "summary" | "handoff">): Promise<void> {
  if (!process.env.CNOC_SOCK) throw new ReportError("not inside a Cnoc job (CNOC_SOCK is not set)");
  const usage = await collectUsage();
  const r = await local<{ accepted: boolean }>("/attempt/result", { ...result, ...(usage ? { usage } : {}) });
  const what = result.handoff ? `handoff ${result.handoff} (${result.status})` : result.status;
  console.log(r.accepted ? `reported ${what}` : "a result was already reported for this stage");
}

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
    if (usage && inside) await local("/attempt/usage", { usage });
  } catch {
    // A hook that fails or prints is worse than a missing number.
  }
}
