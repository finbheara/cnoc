/**
 * Templates: Jobfiles saved on the server and started again and again. A run is an ordinary
 * job named `<template>/<n>` from a counter, or `<template>/<key>` when the run has a key.
 */
import type { Database } from "bun:sqlite";
import { JobfileError, type TemplateArg, checkTemplate, declaredKey, fill, keyedId, withId } from "../jobfile";
import type { JobState, Overrides } from "../protocol";
import { SubmitError } from "./errors";

export interface TemplateRow {
  id: number;
  /** The id in the template's front matter. Instances are named `<name>/<n>` or `<name>/<key>`. */
  name: string;
  body: string;
  args: TemplateArg[];
  /** The file it was added from, as the submitter named it. */
  source: string | null;
  added_at: number;
  updated_at: number;
  runs: number;
  last_run_at: number | null;
  last_job: string | null;
}

/** What a template run needs from the store. */
export interface TemplateHost {
  readonly db: Database;
  emit(type: string, f?: { job?: string; actor?: string; data?: unknown }): number;
  meta(k: string, set?: string): string | null;
  job(id: string): { state: JobState; spec: { labels: Record<string, string> } } | null;
  submit(bodies: string[], actor: string, over?: Overrides, labels?: Record<string, string>): unknown;
}

export interface RunOptions {
  /** Names the job `<template>/<key>`, overriding a key the template declares. */
  key?: string;
  /** Refuse the run when neither this call nor the template supplies a key. */
  keyed?: boolean;
}

type Raw = Record<string, unknown>;

/** Runs `f`, turning a Jobfile error into a refusal of the request. */
function refuse<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof JobfileError) throw new SubmitError(e.message);
    throw e;
  }
}

function templateRow(r: Raw | null): TemplateRow | null {
  if (!r) return null;
  const body = r.body as string;
  let args: TemplateArg[] = [];
  try {
    args = checkTemplate(body).args;
  } catch {
    // A template stored by an older version may no longer parse; it still lists and can be removed.
  }
  return { ...(r as unknown as TemplateRow), body, args };
}

export function listTemplates(s: TemplateHost): TemplateRow[] {
  return (s.db.query("SELECT * FROM templates ORDER BY id").all() as Raw[]).map((r) => templateRow(r) as TemplateRow);
}

/** Finds a template by number, by name, or by the file it was added from. */
export function findTemplate(s: TemplateHost, ref: string, path?: string): TemplateRow | null {
  const q = (sql: string, v: string | number) => templateRow(s.db.query(sql).get(v) as Raw | null);
  return (
    (/^\d+$/.test(ref) ? q("SELECT * FROM templates WHERE id = ?", Number(ref)) : null) ??
    q("SELECT * FROM templates WHERE name = ?", ref) ??
    q("SELECT * FROM templates WHERE source = ?", ref) ??
    (path ? q("SELECT * FROM templates WHERE source = ?", path) : null)
  );
}

/** Saves a template. Adding the same name again replaces its content and keeps its number. */
export function addTemplate(
  s: TemplateHost,
  body: string,
  source: string | null,
  actor: string,
): { template: TemplateRow; result: "added" | "updated" | "unchanged" } {
  const name = refuse(() => checkTemplate(body).name);
  return s.db.transaction(() => {
    const have = findTemplate(s, name);
    const now = Date.now();
    let result: "added" | "updated" | "unchanged" = "unchanged";
    if (!have) {
      s.db.run("INSERT INTO templates(name, body, source, added_at, updated_at) VALUES(?,?,?,?,?)", [
        name,
        body,
        source,
        now,
        now,
      ]);
      result = "added";
    } else if (have.body !== body) {
      s.db.run("UPDATE templates SET body = ?, source = ?, updated_at = ? WHERE id = ?", [
        body,
        source ?? have.source,
        now,
        have.id,
      ]);
      result = "updated";
    }
    const template = findTemplate(s, name) as TemplateRow;
    if (result !== "unchanged") s.emit(`template.${result}`, { actor, data: { template: template.id, name } });
    return { template, result };
  })();
}

export function removeTemplate(s: TemplateHost, ref: string, path: string | undefined, actor: string): TemplateRow {
  const t = findTemplate(s, ref, path);
  if (!t) throw new SubmitError(`no such template: ${ref}`, 404);
  s.db.run("DELETE FROM templates WHERE id = ?", [t.id]);
  s.emit("template.removed", { actor, data: { template: t.id, name: t.name } });
  return t;
}

/**
 * Submits a job made from a template. Jobs it started earlier are not affected by later edits.
 * A keyed run whose job already exists changes nothing, whatever state that job is in: it is
 * the same run offered again. A failed one is run again with requeue, not by resubmitting.
 */
export function runTemplate(
  s: TemplateHost,
  ref: string,
  set: Record<string, string>,
  over: Overrides,
  actor: string,
  opts: RunOptions = {},
): { template: TemplateRow; job: string; created: boolean } {
  return s.db.transaction(() => {
    const t = findTemplate(s, ref);
    if (!t) throw new SubmitError(`no such template: ${ref}`, 404);
    // A keyed run that exists is this run offered again. A job by that id that this template did
    // not start is something else, and is refused rather than passed off as the run.
    const existing = (job: string) => {
      const have = s.job(job);
      if (!have) return null;
      if (have.spec.labels.template !== t.name)
        throw new SubmitError(`job ${job} exists and was not started by template ${t.name}`, 409);
      return { template: t, job, created: false };
    };
    // The key is found and looked up before the template is filled, so a repeat is a no-op
    // even when the template or the arguments have changed so far that they no longer fill.
    const given = opts.key;
    const declared = given === undefined ? refuse(() => declaredKey(t.body, set)) : null;
    const key = given ?? declared;
    let job = key === null ? null : refuse(() => keyedId(t.name, key));
    const before = job === null ? null : existing(job);
    if (before) return before;
    if (job === null && opts.keyed)
      throw new SubmitError(`this run has no key: pass a key, or declare \`key:\` in template ${t.name}`);
    const filled = refuse(() => fill(t.body, set));
    if (job === null) {
      // The counter is kept by name and outlives the template, so a removed and re-added
      // template never reuses a job id. It skips ids that exist, keyed runs included.
      const counter = `template-runs:${t.name}`;
      let n = Number(s.meta(counter) ?? 0) + 1;
      while (s.job(`${t.name}/${n}`)) n++;
      s.meta(counter, String(n));
      job = `${t.name}/${n}`;
    }
    const id = job;
    s.submit([refuse(() => withId(filled.text, id))], actor, over, { template: t.name });
    s.db.run("UPDATE templates SET runs = runs + 1, last_run_at = ?, last_job = ? WHERE id = ?", [
      Date.now(),
      id,
      t.id,
    ]);
    s.emit("template.run", { job: id, actor, data: { template: t.id, name: t.name, set, ...(key ? { key } : {}) } });
    return { template: findTemplate(s, String(t.id)) as TemplateRow, job: id, created: true };
  })();
}
