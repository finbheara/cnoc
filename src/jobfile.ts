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
const FRONT_KEYS = new Set(["id", "priority", "resources", "requires", "depends", "time", "labels"]);
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
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) throw new JobfileError(`resource ${k} must be a number >= 0`);
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

export function parseJob(text: string): JobSpec {
  const { front, body, bodyLine } = splitFrontMatter(text);
  if (front === null) throw new JobfileError("missing front matter (--- ... ---) with at least an id", 1);
  let fm: Record<string, unknown>;
  try {
    fm = (YAML.parse(front) ?? {}) as Record<string, unknown>;
  } catch (e) {
    throw new JobfileError(`front matter is not valid YAML: ${(e as Error).message}`);
  }
  if (typeof fm !== "object" || Array.isArray(fm)) throw new JobfileError("front matter must be a map");
  for (const k of Object.keys(fm)) if (!FRONT_KEYS.has(k)) throw new JobfileError(`unknown front matter key: ${k}`);

  const id = fm.id;
  if (typeof id !== "string" || !ID_RE.test(id) || id.length > 200)
    throw new JobfileError(`id is required and must match ${ID_RE.source}`);
  const priority = fm.priority ?? 0;
  if (typeof priority !== "number" || !Number.isInteger(priority)) throw new JobfileError("priority must be an integer");
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
  for (const ins of instructions(body, bodyLine)) {
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
        if (JOB_RESERVED.has(ins.verb)) throw new JobfileError(`${ins.verb} is reserved and not supported yet`, ins.line);
        if (ADAPTER_ONLY.has(ins.verb)) throw new JobfileError(`${ins.verb} belongs in a harness adapter, not a job`, ins.line);
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
    labels,
    env,
    stages,
  };
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
      if (t.length === 3 && t[1]?.value.toUpperCase() === "TIMEOUT") timeout_s = parseDuration(Number(t[2]?.value) || t[2]?.value);
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
export function expand(s: string, vars: Record<string, string>, quote?: (name: string, value: string) => string): string {
  return s.replace(/\$\{([A-Z_]+)\}/g, (whole, name: string) => {
    const v = vars[name];
    if (v === undefined) return whole;
    return quote ? quote(name, v) : v;
  });
}
