/**
 * Token usage of the harness session a `cnoc` command was run from, read from the harness's own
 * transcript. Collectors are keyed by harness; only Claude Code has one so far.
 *
 * Nothing here may cost a result: every failure comes back as no usage, or as usage marked
 * `partial`, never as an exception, and never later than the time limit.
 */
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TokenCounts, Usage } from "./protocol";

/** The most time a read of one session's transcripts may take before it settles for what it has. */
export const USAGE_READ_MS = 3000;
/** Past the time limit, how long a read stuck in one call may take before it is given up as no usage. */
const USAGE_GIVE_UP_MARGIN_MS = 500;
/** A line longer than this is skipped unread. No line that carries usage comes near it. */
export const MAX_LINE_CHARS = 32 * 1024 * 1024;
/** How deep subagent transcripts are looked for under `<session>/subagents/`. Workflows nest two levels. */
const MAX_SUBAGENT_DEPTH = 4;
/** Limits on usage that arrives over the local socket and is passed on to the server. */
export const MAX_MODELS = 32;
const MAX_NAME_CHARS = 200;
const MAX_PARTIAL_CHARS = 500;
/** Where the models past MAX_MODELS are counted together. */
const OTHER_MODELS = "(other)";

/** What a Claude Code hook passes on stdin, as far as usage is concerned. */
export interface HookInput {
  session_id?: string;
  transcript_path?: string;
}

/** Where one harness session's transcripts are. */
interface Source {
  session: string;
  /** The session's own transcript first, then any of its subagents'. */
  files: string[];
}

export interface Collector {
  /** Variables the harness exports to the commands its session runs, naming that session. */
  sessionVars: string[];
  /** Finds the calling session's transcripts, or null when this is not that harness's session. */
  locate(env: Record<string, string | undefined>, hook: HookInput | null): Promise<Source | null>;
  /** Null when the session's own transcript cannot be read. */
  read(source: Source, deadline: number): Promise<Usage | null>;
}

export const zero = (): TokenCounts => ({ input: 0, output: 0, cache_creation: 0, cache_read: 0 });

const add = (into: TokenCounts, n: TokenCounts): void => {
  into.input += n.input;
  into.output += n.output;
  into.cache_creation += n.cache_creation;
  into.cache_read += n.cache_read;
};

/**
 * Lines of a byte stream, decoded as they arrive, so a transcript of hundreds of megabytes is
 * never held whole. A line over `maxLine` characters is skipped. The deadline is checked between chunks.
 */
export async function* lines(
  stream: ReadableStream<Uint8Array>,
  deadline: number,
  maxLine = MAX_LINE_CHARS,
  now: () => number = Date.now,
): AsyncGenerator<string, "timeout" | "eof"> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let rest = "";
  let skipping = false;
  try {
    for (;;) {
      if (now() > deadline) return "timeout";
      const { done, value } = await reader.read();
      const text = done ? decoder.decode() : decoder.decode(value, { stream: true });
      let start = 0;
      for (let nl = text.indexOf("\n"); nl >= 0; nl = text.indexOf("\n", start)) {
        const line = rest + text.slice(start, nl);
        rest = "";
        start = nl + 1;
        if (!skipping && line.length <= maxLine) yield line;
        skipping = false;
      }
      if (!skipping) rest += text.slice(start);
      if (rest.length > maxLine) [rest, skipping] = ["", true];
      if (done) {
        if (rest && !skipping) yield rest;
        return "eof";
      }
    }
  } finally {
    await reader.cancel().catch(() => /* the stream already ended or failed: nothing to release */ undefined);
  }
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** True for a regular file. A FIFO, a device or a directory named `*.jsonl` is not a transcript. */
const isFile = async (p: string): Promise<boolean> =>
  (await stat(p).catch(() => /* cannot stat: not a transcript */ null))?.isFile() ?? false;

/** Every `*.jsonl` file under a directory, depth first, not following symbolic links. */
async function jsonlUnder(dir: string, depth = 0): Promise<string[]> {
  if (depth > MAX_SUBAGENT_DEPTH) return [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await jsonlUnder(p, depth + 1)));
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

const claude: Collector = {
  sessionVars: ["CLAUDE_CODE_SESSION_ID"],
  async locate(env, hook) {
    const session = hook?.session_id || env.CLAUDE_CODE_SESSION_ID;
    if (!session || !SESSION_ID.test(session)) return null;
    let main = hook?.transcript_path && (await isFile(hook.transcript_path)) ? hook.transcript_path : null;
    if (!main) {
      // `projects/<the cwd, encoded>/<session>.jsonl`. The encoding is Claude Code's business; find the file by name.
      const projects = join(env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude"), "projects");
      for (const d of await readdir(projects).catch(() => [])) {
        const f = join(projects, d, `${session}.jsonl`);
        if (await isFile(f)) {
          main = f;
          break;
        }
      }
    }
    if (!main) return null;
    return { session, files: [main, ...(await jsonlUnder(join(main.replace(/\.jsonl$/, ""), "subagents")))] };
  },

  /**
   * Claude Code writes one line per content block of a response, and every line of a response
   * carries the response's usage under the same `message.id`. The input and cache counts repeat
   * exactly; `output_tokens` can be lower on the early blocks, and the lines are not always in
   * order. So each response is counted once, taking the largest value of each count seen for its
   * id, and ids are shared across all of the session's files because a subagent's transcript can
   * repeat responses that another one already holds.
   */
  async read(source, deadline) {
    const seen = new Map<string, { model: string; n: TokenCounts }>();
    const problems: string[] = [];
    let unreadable = 0;
    let timedOut = false;
    for (const [i, file] of source.files.entries()) {
      try {
        let n = 0;
        const it = lines(Bun.file(file).stream(), deadline);
        for (let r = await it.next(); ; r = await it.next()) {
          if (r.done) {
            timedOut = r.value === "timeout";
            break;
          }
          n++;
          const line = r.value;
          if (!line.includes('"usage"')) continue;
          let o: { type?: string; requestId?: string; message?: { id?: string; model?: string; usage?: unknown } };
          try {
            o = JSON.parse(line);
          } catch {
            unreadable++;
            continue;
          }
          const u = o?.message?.usage as Record<string, unknown> | undefined;
          if (o?.type !== "assistant" || !u || typeof u !== "object") continue;
          const num = (k: string) => (count(u[k]) ? (u[k] as number) : 0);
          const counts: TokenCounts = {
            input: num("input_tokens"),
            output: num("output_tokens"),
            cache_creation: num("cache_creation_input_tokens"),
            cache_read: num("cache_read_input_tokens"),
          };
          // Error and placeholder entries (model "<synthetic>") carry all zeros.
          if (!counts.input && !counts.output && !counts.cache_creation && !counts.cache_read) continue;
          const key = String(o.message?.id ?? o.requestId ?? `${i}:${n}`);
          const prev = seen.get(key);
          if (!prev) {
            seen.set(key, { model: String(o.message?.model ?? "unknown").slice(0, MAX_NAME_CHARS), n: counts });
            continue;
          }
          prev.n.input = Math.max(prev.n.input, counts.input);
          prev.n.output = Math.max(prev.n.output, counts.output);
          prev.n.cache_creation = Math.max(prev.n.cache_creation, counts.cache_creation);
          prev.n.cache_read = Math.max(prev.n.cache_read, counts.cache_read);
        }
      } catch {
        // Without the session's own transcript there is nothing worth reporting.
        if (i === 0) return null;
        problems.push("a subagent transcript could not be read");
      }
      if (timedOut) {
        problems.push("read stopped at its time limit");
        break;
      }
    }
    if (unreadable) problems.push(`${unreadable} line${unreadable === 1 ? "" : "s"} with usage could not be parsed`);
    const tokens = zero();
    const models = new Map<string, TokenCounts>();
    for (const { model, n } of seen.values()) {
      add(tokens, n);
      const name = models.has(model) || models.size < MAX_MODELS - 1 ? model : OTHER_MODELS;
      if (!models.has(name)) models.set(name, zero());
      add(models.get(name) as TokenCounts, n);
    }
    return {
      harness: "claude",
      session: source.session,
      tokens,
      // fromEntries defines own properties, so a model named `__proto__` is only a name.
      by_model: Object.fromEntries(models),
      responses: seen.size,
      at: Date.now(),
      ...(problems.length ? { partial: [...new Set(problems)].join("; ") } : {}),
    };
  },
};

/** Collectors by harness name. A second harness adds an entry here. */
export const COLLECTORS: Record<string, Collector> = { claude };
export const SESSION_VARS: string[] = Object.values(COLLECTORS).flatMap((c) => c.sessionVars);

/**
 * The usage of the harness session this process runs inside, or null if it is in none that a
 * collector knows, or the transcript cannot be read. Never throws, and settles within the time
 * limit plus a small margin even if a read never returns.
 */
export async function collectUsage(
  env: Record<string, string | undefined> = process.env,
  hook: HookInput | null = null,
  ms = USAGE_READ_MS,
  collectors: Record<string, Collector> = COLLECTORS,
): Promise<Usage | null> {
  const deadline = Date.now() + ms;
  const work = (async () => {
    for (const c of Object.values(collectors)) {
      try {
        const source = await c.locate(env, hook);
        if (source) return await c.read(source, deadline);
      } catch {
        // A collector that fails reports nothing; the result goes through without usage.
      }
    }
    return null;
  })();
  let timer: Timer | undefined;
  const giveUp = new Promise<null>((r) => {
    timer = setTimeout(() => r(null), Math.max(0, ms) + USAGE_GIVE_UP_MARGIN_MS);
  });
  const out = await Promise.race([work, giveUp]);
  clearTimeout(timer);
  return out;
}

const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const name = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_NAME_CHARS;

function counts(c: unknown): TokenCounts | null {
  const o = c as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return null;
  const out = zero();
  for (const k of Object.keys(out) as Array<keyof TokenCounts>) {
    const v = o[k];
    if (!count(v)) return null;
    out[k] = v;
  }
  return out;
}

/**
 * Checks a usage object that came over the local socket before it is stored and passed on.
 * Anything that does not conform is dropped, not refused: the whole usage if its names or totals
 * are wrong, a model entry if its own are, models past MAX_MODELS.
 */
export function cleanUsage(x: unknown): Usage | undefined {
  const u = x as Partial<Usage> | null;
  if (!u || typeof u !== "object" || !name(u.harness) || !name(u.session)) return undefined;
  const tokens = counts(u.tokens);
  if (!tokens || !count(u.responses) || !count(u.at)) return undefined;
  const models = new Map<string, TokenCounts>();
  const given = u.by_model && typeof u.by_model === "object" ? Object.entries(u.by_model) : [];
  for (const [m, c] of given) {
    if (models.size >= MAX_MODELS) break;
    const n = counts(c);
    if (n && name(m)) models.set(m, n);
  }
  return {
    harness: u.harness,
    session: u.session,
    tokens,
    by_model: Object.fromEntries(models),
    responses: u.responses,
    at: u.at,
    ...(typeof u.partial === "string" ? { partial: u.partial.slice(0, MAX_PARTIAL_CHARS) } : {}),
  };
}

/**
 * Of a report's own usage and the stage's last snapshot, the one to keep. A reading of another
 * session never displaces the report's. A partial reading is a lower bound, so a complete one wins
 * only if it counted at least as many responses; otherwise the one that counted more wins, and on
 * a tie, the report's.
 */
export function betterUsage(report: Usage | null | undefined, snap: Usage | null | undefined): Usage | undefined {
  if (!report || !snap) return report ?? snap ?? undefined;
  if (report.session !== snap.session) return report;
  if (Boolean(report.partial) !== Boolean(snap.partial)) {
    const [complete, partial] = report.partial ? [snap, report] : [report, snap];
    return complete.responses >= partial.responses ? complete : partial;
  }
  return snap.responses > report.responses ? snap : report;
}

/** One line for `cnoc show`: `claude 1234 in, 56 out, 7 cache write, 89 cache read (model-a, model-b)`. */
export function formatUsage(u: Usage): string {
  const t = u.tokens ?? zero();
  const models = Object.keys(u.by_model ?? {});
  return (
    `${u.harness} ${t.input} in, ${t.output} out, ${t.cache_creation} cache write, ${t.cache_read} cache read` +
    ` (${models.join(", ") || "no model"})${u.partial ? `; partial: ${u.partial}` : ""}`
  );
}
