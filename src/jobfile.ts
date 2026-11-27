/**
 * Jobfile and harness-adapter parsing.
 *
 * Both are line-per-instruction files in the Dockerfile tradition. A Jobfile has YAML
 * front matter (what the server schedules on) and a body (what the client runs). An
 * adapter is the same syntax with the terminal verbs, and is what `HARNESS x` expands to.
 */
import { YAML } from "bun";
import type { JobSpec, Resources, Stage } from "./protocol";

export class JobfileError extends Error {
  constructor(
    message: string,
    readonly line?: number,
  ) {
    super(line ? `line ${line}: ${message}` : message);
  }
}

interface Instr {
  verb: string;
  rest: string;
  line: number;
}

export type KeyTok = { text: string } | { key: string };

export type Step =
  | { op: "tmux"; cmd: string }
  | { op: "expect"; pattern: string; timeout_s: number }
  | { op: "type"; keys: KeyTok[] }
  | { op: "sleep"; s: number };

export interface Adapter {
  /** Binaries that must be on PATH for a host to offer this harness. */
  requires: string[];
  steps: Step[];
  /** Run when a session is asked to end, before it is killed. */
  stop: Step[];
}

const ID_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._#-]+)*$/;
const NAME_RE = /^[A-Za-z0-9._-]+$/;
const FRONT_KEYS = new Set(["id", "priority", "resources", "requires", "depends", "time", "begin", "labels"]);
const JOB_RESERVED = new Set(["RUN", "WORKTREE", "WORKDIR"]);
const ADAPTER_ONLY = new Set(["TMUX", "EXPECT", "TYPE", "SLEEP", "STOP", "REQUIRE"]);

export function parseDuration(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.floor(v);
  if (typeof v !== "string") throw new JobfileError(`bad duration: ${JSON.stringify(v)}`);
  const m = v.trim().match(/^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/);
  if (!m || v.trim() === "") throw new JobfileError(`bad duration: ${v}`);
  const [, d, h, min, s] = m;
  const total = Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(s ?? 0);
  if (total <= 0) throw new JobfileError(`bad duration: ${v}`);
  return total;
}

/**
 * When a job may first start: a time with a zone, or `+duration` counted from `now`.
 * A time without a zone is refused, because the submitter and the server may not share one.
 */
export function parseBegin(v: unknown, now: number): number {
  const s = typeof v === "string" ? v.trim() : "";
  if (s.startsWith("+")) return now + parseDuration(s.slice(1)) * 1000;
  const t = /(Z|[+-]\d\d:?\d\d)$/i.test(s) ? Date.parse(s) : Number.NaN;
  if (Number.isNaN(t))
    throw new JobfileError(
      `begin must be a time with a zone, such as 2027-01-31T03:00:00Z, or a delay such as +2h; got ${JSON.stringify(v)}`,
    );
  return t;
}

function splitFrontMatter(text: string): { front: string | null; body: string; bodyLine: number } {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { front: null, body: text, bodyLine: 1 };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0) throw new JobfileError("front matter is not closed with ---", 1);
  return { front: lines.slice(1, end).join("\n"), body: lines.slice(end + 1).join("\n"), bodyLine: end + 2 };
}

function instructions(body: string, firstLine: number): Instr[] {
  const lines = body.split(/\r?\n/);
  const out: Instr[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = firstLine + i;
    let raw = lines[i] ?? "";
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue;
    while (raw.endsWith("\\") && i + 1 < lines.length) raw = `${raw.slice(0, -1)}${lines[++i] ?? ""}`;
    const m = raw.trim().match(/^([A-Za-z]+)(?:\s+([\s\S]*))?$/);
    if (!m) throw new JobfileError(`cannot parse instruction: ${raw.trim()}`, line);
    const verb = (m[1] ?? "").toUpperCase();
    let rest = (m[2] ?? "").trim();
    const here = rest.match(/^<<([A-Za-z_][A-Za-z0-9_]*)$/);
    if (here) {
      const buf: string[] = [];
      let closed = false;
      while (++i < lines.length) {
        if ((lines[i] ?? "").trim() === here[1]) {
          closed = true;
          break;
        }
        buf.push(lines[i] ?? "");
      }
      if (!closed) throw new JobfileError(`heredoc <<${here[1]} is not closed`, line);
      rest = JSON.stringify(buf.join("\n"));
    }
    out.push({ verb, rest, line });
  }
  return out;
}

/** Splits an argument string into quoted strings and bare words. */
function tokens(rest: string, line: number): Array<{ quoted: boolean; value: string }> {
  const out: Array<{ quoted: boolean; value: string }> = [];
  let i = 0;
  while (i < rest.length) {
    const c = rest[i] as string;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < rest.length && rest[j] !== '"') j += rest[j] === "\\" ? 2 : 1;
      if (j >= rest.length) throw new JobfileError("unterminated string", line);
      try {
        out.push({ quoted: true, value: JSON.parse(rest.slice(i, j + 1).replace(/\t/g, "\\t")) as string });
      } catch {
        throw new JobfileError(`bad string escape in ${rest.slice(i, j + 1)}`, line);
      }
      i = j + 1;
    } else {
      let j = i;
      while (j < rest.length && !/\s/.test(rest[j] as string)) j++;
      out.push({ quoted: false, value: rest.slice(i, j) });
      i = j;
    }
  }
  return out;
}

/** A single string argument: quoted, or the raw rest of the line. */
function oneString(rest: string, line: number): string {
  if (!rest.startsWith('"')) return rest;
  const t = tokens(rest, line);
  if (t.length !== 1) throw new JobfileError("expected exactly one quoted string", line);
  return (t[0] as { value: string }).value;
}

function resources(v: unknown): Resources {
  if (v === undefined || v === null) return { slots: 1 };
  if (typeof v !== "object" || Array.isArray(v)) throw new JobfileError("resources must be a map of name: count");
  const out: Resources = {};
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    if (!NAME_RE.test(k)) throw new JobfileError(`bad resource name: ${k}`);
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0)
      throw new JobfileError(`resource ${k} must be a number >= 0`);
    out[k] = n;
  }
  return out;
}

function stringList(v: unknown, what: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" && typeof x !== "number"))
    throw new JobfileError(`${what} must be a list of strings`);
  return v.map(String);
}

export function parseJob(text: string, now = Date.now()): JobSpec {
  const { front, body, bodyLine } = splitFrontMatter(text);
  if (front === null) throw new JobfileError("missing front matter (--- ... ---) with at least an id", 1);
  const instrs = instructions(body, bodyLine);
  // Checked before the front matter, which an unfilled argument can make unreadable.
  const arg = instrs.find((i) => i.verb === "ARG");
  if (arg)
    throw new JobfileError(
      "ARG makes this a template; add it with `cnoc template add` and start it with `cnoc template run`",
      arg.line,
    );
  let fm: Record<string, unknown>;
  try {
    fm = (YAML.parse(front) ?? {}) as Record<string, unknown>;
  } catch (e) {
    throw new JobfileError(`front matter is not valid YAML: ${(e as Error).message}`);
  }
  if (typeof fm !== "object" || Array.isArray(fm)) throw new JobfileError("front matter must be a map");
  if ("key" in fm)
    throw new JobfileError("key belongs in a template, where it names each run; a plain Jobfile is named by its id");
  for (const k of Object.keys(fm)) if (!FRONT_KEYS.has(k)) throw new JobfileError(`unknown front matter key: ${k}`);

  const id = fm.id;
  if (typeof id !== "string" || !ID_RE.test(id) || id.length > 200)
    throw new JobfileError(`id is required and must match ${ID_RE.source}`);
  const priority = fm.priority ?? 0;
  if (typeof priority !== "number" || !Number.isInteger(priority))
    throw new JobfileError("priority must be an integer");
  const depends = stringList(fm.depends, "depends");
  if (depends.includes(id)) throw new JobfileError("a job cannot depend on itself");
  const labels: Record<string, string> = {};
  if (fm.labels !== undefined && fm.labels !== null) {
    if (typeof fm.labels !== "object" || Array.isArray(fm.labels)) throw new JobfileError("labels must be a map");
    for (const [k, v] of Object.entries(fm.labels as Record<string, unknown>)) labels[k] = String(v);
  }

  let project: string | null = null;
  let harness: { name: string; args: string } | null = null;
  const env: Record<string, string> = {};
  const stages: Stage[] = [];
  for (const ins of instrs) {
    switch (ins.verb) {
      case "FROM":
        if (project !== null) throw new JobfileError("FROM may appear only once", ins.line);
        if (!NAME_RE.test(ins.rest)) throw new JobfileError("FROM takes one project name", ins.line);
        project = ins.rest;
        break;
      case "HARNESS": {
        const [name = "", ...args] = ins.rest.split(/\s+/);
        if (!NAME_RE.test(name)) throw new JobfileError("HARNESS takes a harness name", ins.line);
        harness = { name, args: args.join(" ") };
        break;
      }
      case "PROMPT": {
        if (!harness) throw new JobfileError("PROMPT needs a HARNESS before it", ins.line);
        const prompt = oneString(ins.rest, ins.line);
        if (prompt.trim() === "") throw new JobfileError("PROMPT is empty", ins.line);
        stages.push({ harness: harness.name, args: harness.args, prompt });
        break;
      }
      case "ENV": {
        const m = ins.rest.match(/^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/);
        if (!m) throw new JobfileError("ENV takes NAME=value", ins.line);
        env[m[1] as string] = oneString(m[2] as string, ins.line);
        break;
      }
      default:
        if (JOB_RESERVED.has(ins.verb))
          throw new JobfileError(`${ins.verb} is reserved and not supported yet`, ins.line);
        if (ADAPTER_ONLY.has(ins.verb))
          throw new JobfileError(`${ins.verb} belongs in a harness adapter, not a job`, ins.line);
        throw new JobfileError(`unknown instruction: ${ins.verb}`, ins.line);
    }
  }
  if (project === null) throw new JobfileError("FROM <project> is required");
  if (stages.length === 0) throw new JobfileError("at least one PROMPT is required");

  return {
    id,
    project,
    priority,
    resources: resources(fm.resources),
    requires: stringList(fm.requires, "requires"),
    depends,
    time_s: fm.time === undefined || fm.time === null ? null : parseDuration(fm.time),
    begin_at: fm.begin === undefined || fm.begin === null ? null : parseBegin(fm.begin, now),
    labels,
    env,
    stages,
  };
}

// ---- templates --------------------------------------------------------------

export interface TemplateArg {
  name: string;
  /** null when the argument must be given at run time. */
  default: string | null;
}

const ARG_RE = /^([A-Z_][A-Z0-9_]*)(?:=([\s\S]*))?$/;
/** What an ARG name may be, and so what `--set NAME=` may name. */
export const ARG_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

function argLines(text: string): Array<TemplateArg & { line: number }> {
  const { body, bodyLine } = splitFrontMatter(text);
  const out: Array<TemplateArg & { line: number }> = [];
  for (const ins of instructions(body, bodyLine)) {
    if (ins.verb !== "ARG") continue;
    const m = ins.rest.match(ARG_RE);
    if (!m) throw new JobfileError("ARG takes NAME or NAME=default, with the name in capitals", ins.line);
    const name = m[1] as string;
    if (out.some((a) => a.name === name)) throw new JobfileError(`ARG ${name} is declared twice`, ins.line);
    out.push({ name, default: m[2] === undefined ? null : oneString(m[2], ins.line), line: ins.line });
  }
  return out;
}

/** A template with its arguments filled in. */
export interface Filled {
  /** A plain Jobfile: the ARG lines and the `key:` line are blanked. Its id is still the template's name. */
  text: string;
}

/**
 * Fills every `${NAME}` that an ARG line declares and drops the ARG lines and the `key:` line.
 * Names that are not declared are left alone, so shell variables in a prompt pass through.
 */
export function fill(text: string, set: Record<string, string>): Filled {
  const args = argLines(text);
  for (const k of Object.keys(set)) {
    if (!args.some((a) => a.name === k))
      throw new JobfileError(
        `unknown argument ${k}; this template takes: ${args.map((a) => a.name).join(", ") || "none"}`,
      );
  }
  const values = new Map<string, string>();
  for (const a of args) {
    const v = set[a.name] ?? a.default;
    if (v === null || v === undefined) throw new JobfileError(`argument ${a.name} has no default and was not set`);
    if (/[\r\n]/.test(v)) throw new JobfileError(`argument ${a.name} must be a single line`);
    values.set(a.name, v);
  }
  const lines = text.split(/\r?\n/);
  for (const a of args) {
    if ((lines[a.line - 1] ?? "").endsWith("\\")) throw new JobfileError("ARG must fit on one line", a.line);
    lines[a.line - 1] = ""; // blanked, not removed, so later errors keep their line numbers
  }
  const at = frontLine(lines, "key");
  const filled = lines.map((l) =>
    l.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (whole, name: string) => values.get(name) ?? whole),
  );
  if (at >= 0) filled[at] = "";
  return { text: filled.join("\n") };
}

/** Matches a top-level front matter line `name: ...`, with the name optionally quoted. */
const frontKey = (name: string) => new RegExp(`^(["']?)${name}\\1\\s*:`);

/** The index of a top-level front matter line `name: ...`, or -1. */
function frontLine(lines: string[], name: string): number {
  if (lines[0]?.trim() !== "---") return -1;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  const re = frontKey(name);
  return lines.findIndex((l, i) => i > 0 && i < end && re.test(l));
}

/**
 * The key a template declares, filled from `set` and the defaults. Only the `key:` line is
 * filled, and only the arguments it uses must have a value, so the key of a run can be found
 * even when the rest of the template no longer fills with these arguments. null when it has none.
 */
export function declaredKey(text: string, set: Record<string, string>): string | null {
  const k = writtenKey(text);
  if (!k) return null;
  const { written, line } = k;
  const args = new Map(argLines(text).map((a) => [a.name, a]));
  const filled = written.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (whole, name: string) => {
    const a = args.get(name);
    if (!a) return whole;
    const v = set[name] ?? a.default;
    if (v === null || v === undefined) throw new JobfileError(`argument ${name} has no default and was not set`);
    if (/[\r\n]/.test(v)) throw new JobfileError(`argument ${name} must be a single line`);
    return v;
  });
  if (filled === "") throw new JobfileError("key is empty", line);
  return filled;
}

/**
 * The `key:` line's value as the template writes it, arguments unfilled, and its line number.
 * It is read before anything is filled in, so an argument's value can never end the key early
 * with a ` #` or a quote. null when the template declares no key.
 */
export function writtenKey(text: string): { written: string; line: number } | null {
  const lines = text.split(/\r?\n/);
  const at = frontLine(lines, "key");
  if (at < 0) return null;
  return { written: keyText((lines[at] as string).replace(frontKey("key"), "").trim(), at + 1), line: at + 1 };
}

/**
 * The `key:` value as the template writes it, before arguments are filled: bare text taken
 * literally, not as a YAML number (so `0x7` stays `0x7`), up to a ` #` comment; or a quoted
 * YAML string.
 */
function keyText(raw: string, line: number): string {
  let v = raw.replace(/\s+#.*$/, "");
  if (/^["']/.test(raw)) {
    try {
      v = YAML.parse(raw) as string;
    } catch {
      throw new JobfileError(`key is not a valid string: ${raw}`, line);
    }
    if (typeof v !== "string") throw new JobfileError(`key is not a valid string: ${raw}`, line);
  }
  return v;
}

const KEY_RE = /^[A-Za-z0-9._#-]+(\/[A-Za-z0-9._#-]+)*$/;
/** What an argument without a default stands for when a template's key is checked: valid in a key, and not a digit. */
const KEY_STAND_IN = "x";

/** How a key error names the key and what it suggests. */
export interface KeyContext {
  /** Shown for the key instead of its value: the template's own text, say. */
  shown?: string;
  /** The line the key is on. */
  line?: number;
  /** How to fix an all-digit key. */
  digitsFix?: string;
}

/** The id of a keyed run: `<name>/<key>`. The key may contain `/`; the whole must be a valid job id. */
export function keyedId(name: string, key: string, ctx: KeyContext = {}): string {
  const id = `${name}/${key}`;
  const shown = ctx.shown ?? JSON.stringify(key);
  if (!KEY_RE.test(key) || !ID_RE.test(id) || id.length > 200)
    throw new JobfileError(
      `key ${shown} is not a valid id segment: it must match ${KEY_RE.source} and make an id of at most 200 characters`,
      ctx.line,
    );
  // Numbered runs are exactly the all-digit ids, so a key never names one.
  if (/^\d+$/.test(key))
    throw new JobfileError(
      `key ${shown} is all digits, which are the numbers of unkeyed runs; ${ctx.digitsFix ?? "give it a prefix, as in issue-1234"}`,
      ctx.line,
    );
  if (key.split("/").some((p) => p === "." || p === ".."))
    throw new JobfileError(`key ${shown} has a . or .. segment`, ctx.line);
  return id;
}

/** What a run whose template-declared key comes out all digits is told to do. */
export function prefixKeyFix(template: string, text: string): string {
  const written = writtenKey(text)?.written;
  return `prefix the key in template ${template}${written === undefined ? "" : `, as in key: run-${written}`}`;
}

/** Replaces the id in a Jobfile's front matter. */
export function withId(text: string, id: string): string {
  const lines = text.split(/\r?\n/);
  const at = frontLine(lines, "id");
  if (at < 0) throw new JobfileError("a template needs front matter with its own `id:` line");
  lines[at] = `id: ${id}`;
  return lines.join("\n");
}

/** Turns a template into a Jobfile: fills its arguments and, if asked, replaces the id. */
export function instantiate(text: string, set: Record<string, string>, id?: string): string {
  const { text: out } = fill(text, set);
  return id === undefined ? out : withId(out, id);
}

/** True when the text declares arguments, which makes it a template and not a job that can be submitted as it is. */
export function declaresArgs(text: string): boolean {
  return /^\s*ARG\s/im.test(text);
}

/** True for a template: it declares arguments or a run key. */
export function isTemplate(text: string): boolean {
  return declaresArgs(text) || frontLine(text.split(/\r?\n/), "key") >= 0;
}

/** Validates a template as far as it can be without real arguments. Its id is its name. */
export function checkTemplate(text: string): { name: string; args: TemplateArg[] } {
  const args = argLines(text).map(({ name, default: d }) => ({ name, default: d }));
  const { front } = splitFrontMatter(text);
  if (/^id\s*:.*\$\{/m.test(front ?? ""))
    throw new JobfileError("a template's id is its name and cannot contain an argument");
  // Arguments without a default are tried as "1", which is a valid name, count and duration.
  const trial = Object.fromEntries(args.filter((a) => a.default === null).map((a) => [a.name, "1"]));
  const name = parseJob(fill(text, trial).text).id;
  // In the key they are tried as "x" instead: with "1", `key: ${ISSUE}` would look all digits,
  // which only some values make it. A run with such a value is refused then.
  const keyTrial = Object.fromEntries(Object.keys(trial).map((n) => [n, KEY_STAND_IN]));
  const key = declaredKey(text, keyTrial);
  const written = writtenKey(text);
  if (key !== null && written)
    keyedId(name, key, {
      // Named as the template writes it, so an error never shows the stand-in.
      shown: JSON.stringify(written.written),
      line: written.line,
      digitsFix: prefixKeyFix(name, text),
    });
  return { name, args };
}

function terminalStep(verb: string, rest: string, line: number): Step {
  switch (verb) {
    case "TYPE": {
      const keys: KeyTok[] = tokens(rest, line).map((t) => {
        if (t.quoted) return { text: t.value };
        if (!/^[A-Za-z0-9-]+$/.test(t.value)) throw new JobfileError(`bad key name: ${t.value}`, line);
        return { key: t.value };
      });
      if (keys.length === 0) throw new JobfileError("TYPE needs text or key names", line);
      return { op: "type", keys };
    }
    case "SLEEP":
      return { op: "sleep", s: /^\d+(\.\d+)?$/.test(rest) ? Number(rest) : parseDuration(rest) };
    case "EXPECT": {
      const t = tokens(rest, line);
      const pattern = t[0]?.value;
      if (!pattern) throw new JobfileError("EXPECT needs a pattern", line);
      let timeout_s = 60;
      if (t.length === 3 && t[1]?.value.toUpperCase() === "TIMEOUT")
        timeout_s = parseDuration(Number(t[2]?.value) || t[2]?.value);
      else if (t.length !== 1) throw new JobfileError('EXPECT takes "pattern" [TIMEOUT n]', line);
      try {
        new RegExp(pattern);
      } catch {
        throw new JobfileError(`EXPECT pattern is not a valid regular expression: ${pattern}`, line);
      }
      return { op: "expect", pattern, timeout_s };
    }
    default:
      throw new JobfileError(`unknown adapter instruction: ${verb}`, line);
  }
}

export function parseAdapter(text: string): Adapter {
  const adapter: Adapter = { requires: [], steps: [], stop: [] };
  for (const ins of instructions(text, 1)) {
    if (ins.verb === "REQUIRE") {
      adapter.requires.push(...ins.rest.split(/\s+/).filter(Boolean));
    } else if (ins.verb === "TMUX") {
      if (adapter.steps.some((s) => s.op === "tmux")) throw new JobfileError("only one TMUX per adapter", ins.line);
      if (ins.rest === "") throw new JobfileError("TMUX needs a command", ins.line);
      adapter.steps.push({ op: "tmux", cmd: ins.rest });
    } else if (ins.verb === "STOP") {
      const m = ins.rest.match(/^([A-Za-z]+)\s*([\s\S]*)$/);
      if (!m) throw new JobfileError("STOP takes an instruction", ins.line);
      adapter.stop.push(terminalStep((m[1] as string).toUpperCase(), (m[2] as string).trim(), ins.line));
    } else {
      adapter.steps.push(terminalStep(ins.verb, ins.rest, ins.line));
    }
  }
  if (adapter.steps[0]?.op !== "tmux") throw new JobfileError("an adapter must start its session with TMUX");
  return adapter;
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Replaces ${NAME}. Unknown names are left alone so shell variables pass through. */
export function expand(
  s: string,
  vars: Record<string, string>,
  quote?: (name: string, value: string) => string,
): string {
  return s.replace(/\$\{([A-Z_]+)\}/g, (whole, name: string) => {
    const v = vars[name];
    if (v === undefined) return whole;
    return quote ? quote(name, v) : v;
  });
}
