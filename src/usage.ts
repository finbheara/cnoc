/**
 * Token usage of the harness session a `cnoc` command was run from, read from the harness's own
 * transcript. Collectors are keyed by harness; only Claude Code has one so far.
 *
 * Nothing here may cost a result: every failure comes back as no usage, or as usage marked
 * `partial`, never as an exception.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TokenCounts, Usage } from "./protocol";

/** The most time a read of one session's transcripts may take before it settles for what it has. */
export const USAGE_READ_MS = 3000;
/** A line longer than this is skipped unread. No line that carries usage comes near it. */
const MAX_LINE_CHARS = 32 * 1024 * 1024;

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

interface Collector {
  /** Variables the harness exports to the commands its session runs, naming that session. */
  sessionVars: string[];
  /** Finds the calling session's transcripts, or null when this is not that harness's session. */
  locate(env: Record<string, string | undefined>, hook: HookInput | null): Source | null;
  read(source: Source, deadline: number): Promise<Usage>;
}

export const zero = (): TokenCounts => ({ input: 0, output: 0, cache_creation: 0, cache_read: 0 });

const add = (into: TokenCounts, n: TokenCounts): void => {
  into.input += n.input;
  into.output += n.output;
  into.cache_creation += n.cache_creation;
  into.cache_read += n.cache_read;
};

/** Lines of a file, read as a stream so a transcript of hundreds of megabytes is never held whole. */
async function* lines(file: string, deadline: number): AsyncGenerator<string, "timeout" | "eof"> {
  const reader = Bun.file(file).stream().getReader();
  const decoder = new TextDecoder();
  let rest = "";
  let skipping = false;
  try {
    for (;;) {
      if (Date.now() > deadline) return "timeout";
      const { done, value } = await reader.read();
      const text = done ? decoder.decode() : decoder.decode(value, { stream: true });
      let start = 0;
      for (let nl = text.indexOf("\n"); nl >= 0; nl = text.indexOf("\n", start)) {
        const line = rest + text.slice(start, nl);
        rest = "";
        start = nl + 1;
        if (!skipping) yield line;
        skipping = false;
      }
      if (!skipping) rest += text.slice(start);
      if (rest.length > MAX_LINE_CHARS) [rest, skipping] = ["", true];
      if (done) {
        if (rest && !skipping) yield rest;
        return "eof";
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Every `*.jsonl` under a directory, depth first. Subagent transcripts nest (workflows have their own folder). */
function jsonlUnder(dir: string): string[] {
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return out;
  }
  for (const n of names) {
    const p = join(dir, n);
    try {
      if (statSync(p).isDirectory()) out.push(...jsonlUnder(p));
      else if (n.endsWith(".jsonl")) out.push(p);
    } catch {
      // Gone between the listing and the stat: nothing to count.
    }
  }
  return out;
}

const claude: Collector = {
  sessionVars: ["CLAUDE_CODE_SESSION_ID"],
  locate(env, hook) {
    const session = hook?.session_id || env.CLAUDE_CODE_SESSION_ID;
    if (!session || !SESSION_ID.test(session)) return null;
    let main = hook?.transcript_path && existsSync(hook.transcript_path) ? hook.transcript_path : null;
    if (!main) {
      // `projects/<the cwd, encoded>/<session>.jsonl`. The encoding is Claude Code's business; find the file by name.
      const projects = join(env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude"), "projects");
      let dirs: string[] = [];
      try {
        dirs = readdirSync(projects);
      } catch {
        return null;
      }
      main = dirs.map((d) => join(projects, d, `${session}.jsonl`)).find((f) => existsSync(f)) ?? null;
    }
    if (!main) return null;
    return { session, files: [main, ...jsonlUnder(join(main.replace(/\.jsonl$/, ""), "subagents"))] };
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
    for (const [i, file] of source.files.entries()) {
      try {
        let n = 0;
        const it = lines(file, deadline);
        for (let r = await it.next(); ; r = await it.next()) {
          if (r.done) {
            if (r.value === "timeout") problems.push("read stopped at its time limit");
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
          const num = (k: string) => (typeof u[k] === "number" && Number.isFinite(u[k]) ? (u[k] as number) : 0);
          const counts: TokenCounts = {
            input: num("input_tokens"),
            output: num("output_tokens"),
            cache_creation: num("cache_creation_input_tokens"),
            cache_read: num("cache_read_input_tokens"),
          };
          // Error and placeholder entries (model "<synthetic>") carry all zeros.
          if (!counts.input && !counts.output && !counts.cache_creation && !counts.cache_read) continue;
          const key = o.message?.id ?? o.requestId ?? `${i}:${n}`;
          const prev = seen.get(key);
          if (!prev) {
            seen.set(key, { model: String(o.message?.model ?? "unknown"), n: counts });
            continue;
          }
          prev.n.input = Math.max(prev.n.input, counts.input);
          prev.n.output = Math.max(prev.n.output, counts.output);
          prev.n.cache_creation = Math.max(prev.n.cache_creation, counts.cache_creation);
          prev.n.cache_read = Math.max(prev.n.cache_read, counts.cache_read);
        }
      } catch {
        problems.push(`${i === 0 ? "transcript" : "a subagent transcript"} could not be read`);
      }
      if (problems.some((p) => p.startsWith("read stopped"))) break;
    }
    if (unreadable) problems.push(`${unreadable} line${unreadable === 1 ? "" : "s"} with usage could not be parsed`);
    const tokens = zero();
    const by_model: Record<string, TokenCounts> = {};
    for (const { model, n } of seen.values()) {
      add(tokens, n);
      by_model[model] ??= zero();
      add(by_model[model], n);
    }
    return {
      harness: "claude",
      session: source.session,
      tokens,
      by_model,
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
 * collector knows, or the transcript cannot be found. Never throws.
 */
export async function collectUsage(
  env: Record<string, string | undefined> = process.env,
  hook: HookInput | null = null,
  ms = USAGE_READ_MS,
): Promise<Usage | null> {
  for (const c of Object.values(COLLECTORS)) {
    try {
      const source = c.locate(env, hook);
      if (source) return await c.read(source, Date.now() + ms);
    } catch {
      // A collector that fails reports nothing; the result goes through without usage.
    }
  }
  return null;
}

/** Checks a usage object that came over the local socket. Anything malformed is dropped, not refused. */
export function cleanUsage(x: unknown): Usage | undefined {
  const u = x as Partial<Usage> | null;
  const counts = (c: unknown): TokenCounts | null => {
    const o = c as Record<string, unknown> | null;
    if (!o || typeof o !== "object") return null;
    const out = zero();
    for (const k of Object.keys(out) as Array<keyof TokenCounts>) {
      const v = o[k];
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
      out[k] = v;
    }
    return out;
  };
  if (!u || typeof u !== "object" || typeof u.harness !== "string" || typeof u.session !== "string") return undefined;
  const tokens = counts(u.tokens);
  if (!tokens) return undefined;
  const by_model: Record<string, TokenCounts> = {};
  for (const [m, c] of Object.entries(u.by_model ?? {})) {
    const n = counts(c);
    if (n) by_model[m] = n;
  }
  return {
    harness: u.harness,
    session: u.session,
    tokens,
    by_model,
    responses: typeof u.responses === "number" ? u.responses : 0,
    at: typeof u.at === "number" ? u.at : Date.now(),
    ...(typeof u.partial === "string" ? { partial: u.partial } : {}),
  };
}

/** One line for `cnoc show`: `claude 1234 in, 56 out, 7 cache write, 89 cache read (2 models)`. */
export function formatUsage(u: Usage): string {
  const t = u.tokens;
  const models = Object.keys(u.by_model);
  return (
    `${u.harness} ${t.input} in, ${t.output} out, ${t.cache_creation} cache write, ${t.cache_read} cache read` +
    ` (${models.join(", ") || "no model"})${u.partial ? `; partial: ${u.partial}` : ""}`
  );
}
