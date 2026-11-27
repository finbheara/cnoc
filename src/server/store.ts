/**
 * Durable state: jobs, dependency edges, attempts, hosts and the changelog.
 * Every mutation appends at least one changelog event in the same transaction.
 */
import { Database } from "bun:sqlite";
import { JobfileError, type TemplateArg, checkTemplate, instantiate, parseBegin, parseJob } from "../jobfile";
import type { AttemptEnd, ChangeEvent, JobSpec, JobState, Measured, Overrides, Resources } from "../protocol";
import { TERMINAL } from "../protocol";

export interface JobRow {
  id: string;
  body: string;
  spec: JobSpec;
  state: JobState;
  reason: string | null;
  cancel_requested: boolean;
  submitted_at: number;
  updated_at: number;
  result: unknown;
}

export interface AttemptRow {
  id: number;
  job: string;
  host: string;
  state: "assigned" | "running" | "ended" | "returned";
  outcome: string | null;
  reason: string | null;
  assigned_at: number;
  started_at: number | null;
  ended_at: number | null;
  result: unknown;
}

export interface HostRow {
  name: string;
  pubkey: string;
  status: "pending" | "approved";
  drained: boolean;
  capacity: Resources;
  features: string[];
  measured: Measured | null;
  version: string | null;
  last_seen: number | null;
}

export interface TemplateRow {
  id: number;
  /** The id in the template's front matter. Instances are named `<name>/<n>`. */
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

export interface Subscription {
  id: number;
  url: string;
  types: string[];
  secret: string;
  cursor: number;
}

export class SubmitError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

type Raw = Record<string, unknown>;
const json = (v: unknown): string => JSON.stringify(v ?? null);
const parse = <T>(v: unknown, fallback: T): T => (typeof v === "string" ? (JSON.parse(v) as T) : fallback);

export class Store {
  readonly db: Database;
  private listeners = new Set<() => void>();

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`CREATE TABLE IF NOT EXISTS jobs(
      id TEXT PRIMARY KEY, body TEXT NOT NULL, spec TEXT NOT NULL, state TEXT NOT NULL, reason TEXT,
      cancel_requested INTEGER NOT NULL DEFAULT 0, submitted_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, result TEXT)`);
    this.db.run("CREATE TABLE IF NOT EXISTS deps(job TEXT NOT NULL, dep TEXT NOT NULL, PRIMARY KEY(job, dep))");
    this.db.run(`CREATE TABLE IF NOT EXISTS attempts(
      id INTEGER PRIMARY KEY AUTOINCREMENT, job TEXT NOT NULL, host TEXT NOT NULL, state TEXT NOT NULL, outcome TEXT,
      reason TEXT, assigned_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER, result TEXT)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS hosts(
      name TEXT PRIMARY KEY, pubkey TEXT NOT NULL, status TEXT NOT NULL, drained INTEGER NOT NULL DEFAULT 0,
      capacity TEXT, features TEXT, measured TEXT, version TEXT, last_seen INTEGER)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS events(
      seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, type TEXT NOT NULL, job TEXT, attempt INTEGER,
      host TEXT, actor TEXT, data TEXT)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS subscriptions(
      id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, types TEXT NOT NULL, secret TEXT NOT NULL, cursor INTEGER NOT NULL)`);
    this.db.run("CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    this.db.run(`CREATE TABLE IF NOT EXISTS templates(
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, body TEXT NOT NULL, source TEXT,
      added_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, runs INTEGER NOT NULL DEFAULT 0, last_run_at INTEGER, last_job TEXT)`);
  }

  close(): void {
    this.db.close();
  }

  // ---- changelog -----------------------------------------------------------

  onEvent(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(type: string, f: { job?: string; attempt?: number; host?: string; actor?: string; data?: unknown } = {}): number {
    const r = this.db.run("INSERT INTO events(ts, type, job, attempt, host, actor, data) VALUES(?,?,?,?,?,?,?)", [
      Date.now(),
      type,
      f.job ?? null,
      f.attempt ?? null,
      f.host ?? null,
      f.actor ?? null,
      json(f.data),
    ]);
    queueMicrotask(() => {
      for (const l of this.listeners) l();
    });
    return Number(r.lastInsertRowid);
  }

  seq(): number {
    return (this.db.query("SELECT COALESCE(MAX(seq), 0) AS s FROM events").get() as { s: number }).s;
  }

  events(after: number, limit = 500, types?: string[]): ChangeEvent[] {
    const rows = this.db.query("SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?").all(after, limit) as Raw[];
    return rows
      .map((r) => ({ ...(r as unknown as ChangeEvent), data: parse(r.data, null) }))
      .filter((e) => !types?.length || types.includes(e.type));
  }

  meta(k: string, set?: string): string | null {
    if (set !== undefined) this.db.run("INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [k, set]);
    return (this.db.query("SELECT v FROM meta WHERE k = ?").get(k) as { v: string } | null)?.v ?? null;
  }

  // ---- jobs ----------------------------------------------------------------

  private jobRow(r: Raw | null): JobRow | null {
    if (!r) return null;
    return {
      id: r.id as string,
      body: r.body as string,
      spec: parse<JobSpec>(r.spec, {} as JobSpec),
      state: r.state as JobState,
      reason: (r.reason as string | null) ?? null,
      cancel_requested: r.cancel_requested === 1,
      submitted_at: r.submitted_at as number,
      updated_at: r.updated_at as number,
      result: parse(r.result, null),
    };
  }

  job(id: string): JobRow | null {
    return this.jobRow(this.db.query("SELECT * FROM jobs WHERE id = ?").get(id) as Raw | null);
  }

  jobs(states?: JobState[]): JobRow[] {
    const rows = this.db.query("SELECT * FROM jobs ORDER BY submitted_at, rowid").all() as Raw[];
    return rows.map((r) => this.jobRow(r) as JobRow).filter((j) => !states || states.includes(j.state));
  }

  dependents(id: string): string[] {
    return (this.db.query("SELECT job FROM deps WHERE dep = ?").all(id) as Array<{ job: string }>).map((r) => r.job);
  }

  private setJob(id: string, state: JobState, reason: string | null, extra: { result?: unknown; cancel?: 0 } = {}): void {
    this.db.run("UPDATE jobs SET state = ?, reason = ?, updated_at = ? WHERE id = ?", [state, reason, Date.now(), id]);
    if (extra.result !== undefined) this.db.run("UPDATE jobs SET result = ? WHERE id = ?", [json(extra.result), id]);
    if (extra.cancel === 0) this.db.run("UPDATE jobs SET cancel_requested = 0 WHERE id = ?", [id]);
  }

  /** queued when every dependency is done, otherwise blocked. */
  private restingState(spec: JobSpec): { state: "queued" | "blocked"; reason: string | null } {
    const waiting = spec.depends.filter((d) => this.job(d)?.state !== "done");
    if (waiting.length === 0) return { state: "queued", reason: null };
    const dead = waiting.filter((d) => ["failed", "cancelled"].includes(this.job(d)?.state ?? ""));
    return { state: "blocked", reason: dead.length ? `dependency-not-done: ${dead.join(", ")}` : null };
  }

  /**
   * Submits a batch atomically. A job already present with the same body is a no-op, so a
   * submitter can retry blindly; the same id with a different body is refused.
   */
  submit(
    bodies: string[],
    actor: string,
    over: Overrides = {},
    labels: Record<string, string> = {},
  ): Array<{ id: string; state: JobState; created: boolean }> {
    const now = Date.now();
    if (over.on !== undefined && !this.host(over.on)) throw new SubmitError(`no such host: ${over.on}`, 404);
    if (over.priority !== undefined && !Number.isInteger(over.priority)) throw new SubmitError("priority must be an integer");
    const specs = bodies.map((body, i) => {
      try {
        const spec = parseJob(body, now);
        if (over.on !== undefined && !spec.requires.includes(`host/${over.on}`)) spec.requires.push(`host/${over.on}`);
        if (over.priority !== undefined) spec.priority = over.priority;
        if (over.begin !== undefined) spec.begin_at = parseBegin(over.begin, now);
        Object.assign(spec.labels, labels);
        return { body, spec };
      } catch (e) {
        if (e instanceof JobfileError) throw new SubmitError(`job ${i + 1}: ${e.message}`);
        throw e;
      }
    });
    const batch = new Map<string, JobSpec>();
    for (const { spec } of specs) {
      if (batch.has(spec.id)) throw new SubmitError(`duplicate id in batch: ${spec.id}`);
      batch.set(spec.id, spec);
    }
    const fresh = specs.filter(({ body, spec }) => {
      const have = this.job(spec.id);
      if (have && have.body !== body) throw new SubmitError(`job ${spec.id} already exists with different content`, 409);
      return !have;
    });
    for (const { spec } of fresh) {
      for (const d of spec.depends) if (!batch.has(d) && !this.job(d)) throw new SubmitError(`job ${spec.id} depends on unknown job ${d}`);
    }
    // Existing jobs cannot point at new ones, so a cycle can only run through this batch.
    const visiting = new Set<string>();
    const cleared = new Set<string>();
    const walk = (id: string): void => {
      if (cleared.has(id)) return;
      if (visiting.has(id)) throw new SubmitError(`dependency cycle through ${id}`);
      visiting.add(id);
      for (const d of batch.get(id)?.depends ?? []) if (batch.has(d)) walk(d);
      visiting.delete(id);
      cleared.add(id);
    };
    for (const id of batch.keys()) walk(id);

    const out: Array<{ id: string; state: JobState; created: boolean }> = [];
    this.db.transaction(() => {
      for (const { body, spec } of fresh) {
        this.db.run("INSERT INTO jobs(id, body, spec, state, submitted_at, updated_at) VALUES(?,?,?,?,?,?)", [
          spec.id,
          body,
          json(spec),
          "blocked",
          now,
          now,
        ]);
        for (const d of spec.depends) this.db.run("INSERT INTO deps(job, dep) VALUES(?, ?)", [spec.id, d]);
      }
      for (const { spec } of fresh) {
        const rest = this.restingState(spec);
        this.setJob(spec.id, rest.state, rest.reason);
        this.emit("job.submitted", {
          job: spec.id,
          actor,
          data: { state: rest.state, project: spec.project, depends: spec.depends, ...(Object.keys(over).length ? { overrides: over } : {}) },
        });
      }
      for (const { spec } of specs) {
        const j = this.job(spec.id) as JobRow;
        out.push({ id: spec.id, state: j.state, created: fresh.some((f) => f.spec.id === spec.id) });
      }
    })();
    return out;
  }

  /** Re-evaluates jobs waiting on `dep` after it changed state. */
  private wake(dep: string): void {
    for (const id of this.dependents(dep)) {
      const j = this.job(id);
      if (!j || j.state !== "blocked") continue;
      const rest = this.restingState(j.spec);
      if (rest.state === "queued") {
        this.setJob(id, "queued", null);
        this.emit("job.ready", { job: id });
      } else if (rest.reason !== j.reason) {
        this.setJob(id, "blocked", rest.reason);
        if (rest.reason) this.emit("job.unstartable", { job: id, data: { reason: rest.reason } });
      }
    }
  }

  private finish(id: string, state: "done" | "failed" | "cancelled", reason: string | null, result: unknown, actor?: string): void {
    this.setJob(id, state, reason, { result, cancel: 0 });
    this.emit("job.terminal", { job: id, actor, data: { state, reason } });
    this.wake(id);
  }

  /** Returns the open attempt to stop, if the job has already been handed to a host. */
  cancel(id: string, actor: string): { job: JobRow; attempt: AttemptRow | null } {
    return this.db.transaction(() => {
      const j = this.job(id);
      if (!j) throw new SubmitError(`no such job: ${id}`, 404);
      if (TERMINAL.includes(j.state)) return { job: j, attempt: null };
      if (j.state === "blocked" || j.state === "queued") {
        this.finish(id, "cancelled", "cancelled-before-start", null, actor);
        return { job: this.job(id) as JobRow, attempt: null };
      }
      this.db.run("UPDATE jobs SET cancel_requested = 1 WHERE id = ?", [id]);
      this.emit("job.cancel_requested", { job: id, actor });
      return { job: this.job(id) as JobRow, attempt: this.openAttempt(id) };
    })();
  }

  requeue(id: string, actor: string): JobRow {
    return this.db.transaction(() => {
      const j = this.job(id);
      if (!j) throw new SubmitError(`no such job: ${id}`, 404);
      if (j.state !== "failed" && j.state !== "cancelled") throw new SubmitError(`job ${id} is ${j.state}; only failed or cancelled jobs can be requeued`, 409);
      const rest = this.restingState(j.spec);
      this.setJob(id, rest.state, rest.reason, { cancel: 0 });
      this.emit("job.requeued", { job: id, actor, data: { state: rest.state } });
      return this.job(id) as JobRow;
    })();
  }

  /** Changes where a job stands in the queue. Only a job no host has been given can move. */
  setPriority(id: string, priority: number, actor: string): JobRow {
    return this.db.transaction(() => {
      const j = this.job(id);
      if (!j) throw new SubmitError(`no such job: ${id}`, 404);
      if (!Number.isInteger(priority)) throw new SubmitError("priority must be an integer");
      if (j.state !== "queued" && j.state !== "blocked") throw new SubmitError(`job ${id} is ${j.state}; only a job that has not been dispatched can be reprioritised`, 409);
      if (j.spec.priority !== priority) {
        this.db.run("UPDATE jobs SET spec = ?, updated_at = ? WHERE id = ?", [json({ ...j.spec, priority }), Date.now(), id]);
        this.emit("job.priority", { job: id, actor, data: { from: j.spec.priority, to: priority } });
      }
      return this.job(id) as JobRow;
    })();
  }

  // ---- templates -----------------------------------------------------------

  private templateRow(r: Raw | null): TemplateRow | null {
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

  templates(): TemplateRow[] {
    return (this.db.query("SELECT * FROM templates ORDER BY id").all() as Raw[]).map((r) => this.templateRow(r) as TemplateRow);
  }

  /** Finds a template by number, by name, or by the file it was added from. */
  template(ref: string, path?: string): TemplateRow | null {
    const q = (sql: string, v: string | number) => this.templateRow(this.db.query(sql).get(v) as Raw | null);
    return (
      (/^\d+$/.test(ref) ? q("SELECT * FROM templates WHERE id = ?", Number(ref)) : null) ??
      q("SELECT * FROM templates WHERE name = ?", ref) ??
      q("SELECT * FROM templates WHERE source = ?", ref) ??
      (path ? q("SELECT * FROM templates WHERE source = ?", path) : null)
    );
  }

  /** Saves a template. Adding the same name again replaces its content and keeps its number. */
  templateAdd(body: string, source: string | null, actor: string): { template: TemplateRow; result: "added" | "updated" | "unchanged" } {
    let name: string;
    try {
      name = checkTemplate(body).name;
    } catch (e) {
      if (e instanceof JobfileError) throw new SubmitError(e.message);
      throw e;
    }
    return this.db.transaction(() => {
      const have = this.template(name);
      const now = Date.now();
      let result: "added" | "updated" | "unchanged" = "unchanged";
      if (!have) {
        this.db.run("INSERT INTO templates(name, body, source, added_at, updated_at) VALUES(?,?,?,?,?)", [name, body, source, now, now]);
        result = "added";
      } else if (have.body !== body) {
        this.db.run("UPDATE templates SET body = ?, source = ?, updated_at = ? WHERE id = ?", [body, source ?? have.source, now, have.id]);
        result = "updated";
      }
      const template = this.template(name) as TemplateRow;
      if (result !== "unchanged") this.emit(`template.${result}`, { actor, data: { template: template.id, name } });
      return { template, result };
    })();
  }

  templateRemove(ref: string, path: string | undefined, actor: string): TemplateRow {
    const t = this.template(ref, path);
    if (!t) throw new SubmitError(`no such template: ${ref}`, 404);
    this.db.run("DELETE FROM templates WHERE id = ?", [t.id]);
    this.emit("template.removed", { actor, data: { template: t.id, name: t.name } });
    return t;
  }

  /** Submits a new job made from a template. Jobs it started earlier are not affected by later edits. */
  templateRun(ref: string, set: Record<string, string>, over: Overrides, actor: string): { template: TemplateRow; job: string } {
    return this.db.transaction(() => {
      const t = this.template(ref);
      if (!t) throw new SubmitError(`no such template: ${ref}`, 404);
      // The counter is kept by name and outlives the template, so a removed and re-added
      // template never reuses a job id.
      const key = `template-runs:${t.name}`;
      let n = Number(this.meta(key) ?? 0) + 1;
      while (this.job(`${t.name}/${n}`)) n++;
      this.meta(key, String(n));
      const job = `${t.name}/${n}`;
      let text: string;
      try {
        text = instantiate(t.body, set, job);
      } catch (e) {
        if (e instanceof JobfileError) throw new SubmitError(e.message);
        throw e;
      }
      this.submit([text], actor, over, { template: t.name });
      this.db.run("UPDATE templates SET runs = runs + 1, last_run_at = ?, last_job = ? WHERE id = ?", [Date.now(), job, t.id]);
      this.emit("template.run", { job, actor, data: { template: t.id, name: t.name, set } });
      return { template: this.template(String(t.id)) as TemplateRow, job };
    })();
  }

  // ---- attempts ------------------------------------------------------------

  private attemptRow(r: Raw | null): AttemptRow | null {
    return r ? ({ ...r, result: parse(r.result, null) } as unknown as AttemptRow) : null;
  }

  attempt(id: number): AttemptRow | null {
    return this.attemptRow(this.db.query("SELECT * FROM attempts WHERE id = ?").get(id) as Raw | null);
  }

  attemptsOf(job: string): AttemptRow[] {
    return (this.db.query("SELECT * FROM attempts WHERE job = ? ORDER BY id").all(job) as Raw[]).map((r) => this.attemptRow(r) as AttemptRow);
  }

  openAttempt(job: string): AttemptRow | null {
    return this.attemptRow(this.db.query("SELECT * FROM attempts WHERE job = ? AND state IN ('assigned','running') ORDER BY id DESC").get(job) as Raw | null);
  }

  openAttempts(host?: string): AttemptRow[] {
    const rows = host
      ? (this.db.query("SELECT * FROM attempts WHERE state IN ('assigned','running') AND host = ?").all(host) as Raw[])
      : (this.db.query("SELECT * FROM attempts WHERE state IN ('assigned','running')").all() as Raw[]);
    return rows.map((r) => this.attemptRow(r) as AttemptRow);
  }

  assign(job: string, host: string): AttemptRow {
    return this.db.transaction(() => {
      const r = this.db.run("INSERT INTO attempts(job, host, state, assigned_at) VALUES(?,?,?,?)", [job, host, "assigned", Date.now()]);
      const id = Number(r.lastInsertRowid);
      this.setJob(job, "assigned", null);
      this.emit("attempt.assigned", { job, attempt: id, host });
      return this.attempt(id) as AttemptRow;
    })();
  }

  /** The host never started it; the job goes back to the queue. */
  giveBack(id: number, reason: string): void {
    this.db.transaction(() => {
      const a = this.attempt(id);
      if (!a || a.state !== "assigned") return;
      this.db.run("UPDATE attempts SET state = 'returned', reason = ?, ended_at = ? WHERE id = ?", [reason, Date.now(), id]);
      const j = this.job(a.job);
      if (j?.cancel_requested) this.finish(a.job, "cancelled", "cancelled-before-start", null);
      else this.setJob(a.job, "queued", null);
      this.emit("attempt.returned", { job: a.job, attempt: id, host: a.host, data: { reason } });
    })();
  }

  /**
   * Marks an attempt running. Also adopts an attempt the server gave back while the host
   * was unreachable, provided the job has not been handed to anyone else since.
   */
  started(id: number, host: string): "ok" | "stale" {
    return this.db.transaction(() => {
      const a = this.attempt(id);
      if (!a || a.host !== host) return "stale";
      if (a.state === "running") return "ok";
      const j = this.job(a.job);
      const adoptable = a.state === "returned" && j?.state === "queued";
      if (a.state !== "assigned" && !adoptable) return "stale";
      this.db.run("UPDATE attempts SET state = 'running', reason = NULL, ended_at = NULL, started_at = COALESCE(started_at, ?) WHERE id = ?", [Date.now(), id]);
      this.setJob(a.job, "running", null);
      this.emit("attempt.started", { job: a.job, attempt: id, host, data: adoptable ? { adopted: true } : null });
      return "ok";
    })();
  }

  /** Records a finished attempt. A report for an attempt that is no longer open is ignored. */
  ended(end: AttemptEnd, host: string): "ok" | "stale" {
    return this.db.transaction(() => {
      if (this.started(end.attempt, host) === "stale") {
        const a = this.attempt(end.attempt);
        if (a) this.emit("attempt.late_report", { job: a.job, attempt: a.id, host, data: { outcome: end.outcome } });
        return "stale";
      }
      const a = this.attempt(end.attempt) as AttemptRow;
      this.db.run("UPDATE attempts SET state = 'ended', outcome = ?, reason = ?, ended_at = ?, result = ? WHERE id = ?", [
        end.outcome,
        end.reason,
        Date.now(),
        json(end.results),
        a.id,
      ]);
      this.emit("attempt.ended", { job: a.job, attempt: a.id, host, data: { outcome: end.outcome, reason: end.reason } });
      this.finish(a.job, end.outcome, end.reason, end.results);
      return "ok";
    })();
  }

  /** Server-side close of an attempt whose host can no longer account for it. */
  fail(id: number, reason: string, actor?: string): void {
    this.db.transaction(() => {
      const a = this.attempt(id);
      if (!a || (a.state !== "assigned" && a.state !== "running")) return;
      this.db.run("UPDATE attempts SET state = 'ended', outcome = 'failed', reason = ?, ended_at = ? WHERE id = ?", [reason, Date.now(), id]);
      this.emit("attempt.ended", { job: a.job, attempt: id, host: a.host, actor, data: { outcome: "failed", reason } });
      this.finish(a.job, "failed", reason, null, actor);
    })();
  }

  // ---- hosts ---------------------------------------------------------------

  private hostRow(r: Raw | null): HostRow | null {
    if (!r) return null;
    return {
      name: r.name as string,
      pubkey: r.pubkey as string,
      status: r.status as "pending" | "approved",
      drained: r.drained === 1,
      capacity: parse<Resources>(r.capacity, {}),
      features: parse<string[]>(r.features, []),
      measured: parse<Measured | null>(r.measured, null),
      version: (r.version as string | null) ?? null,
      last_seen: (r.last_seen as number | null) ?? null,
    };
  }

  host(name: string): HostRow | null {
    return this.hostRow(this.db.query("SELECT * FROM hosts WHERE name = ?").get(name) as Raw | null);
  }

  hosts(): HostRow[] {
    return (this.db.query("SELECT * FROM hosts ORDER BY name").all() as Raw[]).map((r) => this.hostRow(r) as HostRow);
  }

  enroll(name: string, pubkey: string, approved: boolean): HostRow {
    this.db.run("INSERT INTO hosts(name, pubkey, status) VALUES(?,?,?)", [name, pubkey, approved ? "approved" : "pending"]);
    this.emit(approved ? "host.approved" : "host.pending", { host: name });
    return this.host(name) as HostRow;
  }

  approve(name: string, actor: string): HostRow {
    const h = this.host(name);
    if (!h) throw new SubmitError(`no such host: ${name}`, 404);
    if (h.status !== "approved") {
      this.db.run("UPDATE hosts SET status = 'approved' WHERE name = ?", [name]);
      this.emit("host.approved", { host: name, actor });
    }
    return this.host(name) as HostRow;
  }

  drain(name: string, on: boolean, actor: string): HostRow {
    if (!this.host(name)) throw new SubmitError(`no such host: ${name}`, 404);
    this.db.run("UPDATE hosts SET drained = ? WHERE name = ?", [on ? 1 : 0, name]);
    this.emit(on ? "host.drained" : "host.undrained", { host: name, actor });
    return this.host(name) as HostRow;
  }

  inventory(name: string, capacity: Resources, features: string[], version: string): void {
    this.db.run("UPDATE hosts SET capacity = ?, features = ?, version = ?, last_seen = ? WHERE name = ?", [
      json(capacity),
      json(features),
      version,
      Date.now(),
      name,
    ]);
  }

  measured(name: string, m: Measured): void {
    this.db.run("UPDATE hosts SET measured = ?, last_seen = ? WHERE name = ?", [json(m), Date.now(), name]);
  }

  /** Resources held by open attempts, per host, summed from the job specs. */
  reserved(): Map<string, Resources> {
    const out = new Map<string, Resources>();
    for (const a of this.openAttempts()) {
      const spec = this.job(a.job)?.spec;
      if (!spec) continue;
      const r = out.get(a.host) ?? {};
      for (const [n, v] of Object.entries(spec.resources)) r[n] = (r[n] ?? 0) + v;
      out.set(a.host, r);
    }
    return out;
  }

  // ---- webhook subscriptions ----------------------------------------------

  subscriptions(): Subscription[] {
    return (this.db.query("SELECT * FROM subscriptions ORDER BY id").all() as Raw[]).map(
      (r) => ({ ...r, types: parse<string[]>(r.types, []) }) as unknown as Subscription,
    );
  }

  subscribe(url: string, types: string[], secret: string, from: number): Subscription {
    const r = this.db.run("INSERT INTO subscriptions(url, types, secret, cursor) VALUES(?,?,?,?)", [url, json(types), secret, from]);
    return this.subscriptions().find((s) => s.id === Number(r.lastInsertRowid)) as Subscription;
  }

  unsubscribe(id: number): void {
    this.db.run("DELETE FROM subscriptions WHERE id = ?", [id]);
  }

  advance(id: number, cursor: number): void {
    this.db.run("UPDATE subscriptions SET cursor = ? WHERE id = ?", [cursor, id]);
  }
}
