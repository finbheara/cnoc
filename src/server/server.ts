/**
 * The controller: one process, one SQLite file. HTTP for submitters and observers,
 * a WebSocket per host client. If it is down nothing new starts; clients finish what
 * they are running and report when it is back.
 */
import { createHash, createHmac, createPublicKey, randomBytes, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Server as BunServer, ServerWebSocket } from "bun";
import type { ChangeEvent, ClientMsg, JobState, Measured, Overrides, Resources, ServerMsg } from "../protocol";
import { PROTOCOL, TERMINAL, VERSION, impliedFeatures } from "../protocol";
import { type HostView, type Policy, type QueuedJob, defaultPolicy, schedule } from "./scheduler";
import { type AttemptRow, Store, SubmitError } from "./store";

export interface ServerOptions {
  dataDir: string;
  port?: number;
  hostname?: string;
  /** Approve unknown host keys on first contact. For tests and single-user setups. */
  openEnrollment?: boolean;
  /** Fleet-wide counters, e.g. { "claude-max": 3 }. */
  pools?: Resources;
  /** Path to a module whose default export is a Partial<Policy>. */
  policy?: string;
  starveAfterS?: number;
  declineBackoffS?: number;
  version?: string;
  log?: (line: string) => void;
}

interface Conn {
  nonce: string;
  host: string | null;
}

type Role = "admin" | "host";

export function fingerprint(pubkey: string): string {
  return createHash("sha256").update(Buffer.from(pubkey, "base64")).digest("hex").slice(0, 16);
}

export class CnocServer {
  readonly store: Store;
  readonly adminToken: string;
  readonly version: string;
  private http: BunServer<Conn> | null = null;
  private online = new Map<string, ServerWebSocket<Conn>>();
  private hostTokens = new Map<string, string>();
  private backoff = new Map<string, number>();
  private pending: Record<string, string> = {};
  private policy: Policy = defaultPolicy;
  private timers: Timer[] = [];
  private dirty = false;
  private pumping = false;
  private log: (line: string) => void;

  constructor(private opts: ServerOptions) {
    mkdirSync(opts.dataDir, { recursive: true });
    this.store = new Store(join(opts.dataDir, "cnoc.sqlite"));
    this.version = opts.version ?? VERSION;
    this.log = opts.log ?? ((l) => console.log(`[server] ${l}`));
    const tokenFile = join(opts.dataDir, "admin.token");
    if (!existsSync(tokenFile)) writeFileSync(tokenFile, `${randomBytes(24).toString("base64url")}\n`, { mode: 0o600 });
    this.adminToken = readFileSync(tokenFile, "utf8").trim();
  }

  get port(): number {
    return this.http?.port ?? 0;
  }

  get url(): string {
    return `http://${this.opts.hostname ?? "127.0.0.1"}:${this.port}`;
  }

  async start(): Promise<this> {
    if (this.opts.policy) {
      const mod = (await import(resolve(this.opts.policy))) as { default?: Partial<Policy> };
      this.policy = { ...defaultPolicy, ...(mod.default ?? {}) };
    }
    this.http = Bun.serve<Conn, never>({
      port: this.opts.port ?? 7878,
      hostname: this.opts.hostname ?? "127.0.0.1",
      idleTimeout: 255,
      fetch: (req, server) => this.fetch(req, server),
      websocket: {
        open: (ws) => this.send(ws, { t: "challenge", nonce: ws.data.nonce, version: this.version, protocol: PROTOCOL }),
        message: (ws, raw) => {
          try {
            this.onMessage(ws, JSON.parse(String(raw)) as ClientMsg);
          } catch (e) {
            this.log(`bad message from ${ws.data.host ?? "unauthenticated"}: ${(e as Error).message}`);
          }
        },
        close: (ws) => this.onClose(ws),
      },
    });
    // No host is connected yet, so nothing handed out before the restart can be in flight.
    // A host that did start one re-adopts it when it syncs.
    for (const a of this.store.openAttempts()) if (a.state === "assigned") this.store.giveBack(a.id, "server-restarted");
    this.store.onEvent(() => this.kick());
    this.timers.push(setInterval(() => this.kick(), 2000));
    this.kick();
    return this;
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    const http = this.http;
    this.http = null;
    for (const ws of this.online.values()) ws.close(1001, "server stopping");
    await http?.stop(true);
    this.store.close();
  }

  // ---- scheduling ----------------------------------------------------------

  /** Coalesces triggers into one scheduling pass and one webhook pump. */
  private kick(): void {
    if (this.dirty) return;
    this.dirty = true;
    queueMicrotask(() => {
      this.dirty = false;
      if (!this.http) return;
      this.runSchedule();
      void this.pumpWebhooks();
    });
  }

  private hostViews(): HostView[] {
    const reserved = this.store.reserved();
    return this.store
      .hosts()
      .filter((h) => h.status === "approved")
      .map((h) => ({
        name: h.name,
        online: this.online.has(h.name),
        drained: h.drained,
        capacity: h.capacity,
        reserved: reserved.get(h.name) ?? {},
        features: h.features,
        measured: h.measured,
      }));
  }

  private poolState(): Record<string, { total: number; used: number }> {
    const pools: Record<string, { total: number; used: number }> = {};
    for (const [n, total] of Object.entries(this.opts.pools ?? {})) pools[n] = { total, used: 0 };
    for (const a of this.store.openAttempts()) {
      const spec = this.store.job(a.job)?.spec;
      for (const [n, v] of Object.entries(spec?.resources ?? {})) {
        const p = pools[n];
        if (p) p.used += v;
      }
    }
    return pools;
  }

  private runSchedule(): void {
    const now = Date.now();
    const queued = this.store.jobs(["queued"]);
    // A job with a begin time is not offered to the policy until that time. From then on it
    // is aged from its begin time, so it neither jumps ahead nor counts as starved early.
    const notYet = queued.filter((j) => (j.spec.begin_at ?? 0) > now);
    const queue: QueuedJob[] = queued
      .filter((j) => (j.spec.begin_at ?? 0) <= now)
      .map((j) => ({
        id: j.id,
        priority: j.spec.priority,
        submitted_at: Math.max(j.submitted_at, j.spec.begin_at ?? 0),
        resources: j.spec.resources,
        features: impliedFeatures(j.spec),
      }));
    const scheduled = Object.fromEntries(notYet.map((j) => [j.id, "scheduled" as const]));
    if (queue.length === 0) {
      this.pending = scheduled;
      return;
    }
    const placement = schedule(
      queue,
      this.hostViews(),
      {
        now,
        pools: this.poolState(),
        backedOff: (job, host) => (this.backoff.get(`${job}\n${host}`) ?? 0) > now,
        starve_after_s: this.opts.starveAfterS ?? 600,
      },
      this.policy,
    );
    this.pending = { ...placement.pending, ...scheduled };
    for (const { job, host } of placement.assignments) {
      const ws = this.online.get(host);
      const row = this.store.job(job);
      if (!ws || !row) continue;
      const attempt = this.store.assign(job, host);
      this.send(ws, { t: "assign", attempt: attempt.id, spec: row.spec });
    }
  }

  // ---- host clients --------------------------------------------------------

  private send(ws: ServerWebSocket<Conn>, msg: ServerMsg): void {
    ws.send(JSON.stringify(msg));
  }

  private onMessage(ws: ServerWebSocket<Conn>, msg: ClientMsg): void {
    if (msg.t === "hello") return this.onHello(ws, msg);
    const host = ws.data.host;
    if (!host) return ws.close(1008, "hello first");
    switch (msg.t) {
      case "sync":
        return this.onSync(ws, host, msg);
      case "status":
        return this.store.measured(host, msg.measured as Measured);
      case "decline":
        this.backoff.set(`${this.store.attempt(msg.attempt)?.job}\n${host}`, Date.now() + (this.opts.declineBackoffS ?? 60) * 1000);
        return this.store.giveBack(msg.attempt, `declined: ${msg.reason}`);
      case "started":
        if (this.store.started(msg.attempt, host) === "stale") this.send(ws, { t: "cancel", attempt: msg.attempt, reason: "not-yours" });
        else if (this.store.job(this.store.attempt(msg.attempt)?.job ?? "")?.cancel_requested)
          this.send(ws, { t: "cancel", attempt: msg.attempt, reason: "cancelled" });
        return;
      case "progress": {
        const a = this.store.attempt(msg.attempt);
        if (a && a.host === host && a.state === "running")
          this.store.emit("attempt.progress", { job: a.job, attempt: a.id, host, data: { stage: msg.stage, note: msg.note } });
        return;
      }
      case "ended":
        this.store.ended(msg, host);
        return this.send(ws, { t: "ack", attempt: msg.attempt });
    }
  }

  private onHello(ws: ServerWebSocket<Conn>, msg: Extract<ClientMsg, { t: "hello" }>): void {
    if (msg.protocol !== PROTOCOL || msg.version !== this.version) return ws.close(1008, "version mismatch");
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(msg.name)) return ws.close(1008, "bad host name");
    let ok = false;
    try {
      const key = createPublicKey({ key: Buffer.from(msg.pubkey, "base64"), format: "der", type: "spki" });
      ok = verify(null, Buffer.from(`cnoc-hello\n${msg.name}\n${ws.data.nonce}`), key, Buffer.from(msg.sig, "base64"));
    } catch {
      ok = false;
    }
    if (!ok) return ws.close(1008, "bad signature");
    let host = this.store.host(msg.name);
    if (host && host.pubkey !== msg.pubkey) return ws.close(1008, "host name is enrolled with a different key");
    if (!host) host = this.store.enroll(msg.name, msg.pubkey, this.opts.openEnrollment === true);
    if (host.status !== "approved") {
      this.send(ws, { t: "pending", fingerprint: fingerprint(msg.pubkey) });
      return ws.close(1008, "pending approval");
    }
    this.online.get(msg.name)?.close(4001, "replaced by a newer connection");
    ws.data.host = msg.name;
    this.online.set(msg.name, ws);
    const token = randomBytes(24).toString("base64url");
    this.hostTokens.set(token, msg.name);
    this.send(ws, { t: "welcome", host: msg.name, api_token: token, heartbeat_s: 10 });
  }

  /** Reconciles the server's view of a host with what the host says it is running. */
  private onSync(ws: ServerWebSocket<Conn>, host: string, msg: Extract<ClientMsg, { t: "sync" }>): void {
    // host/<name> lets a job ask for one host. The server adds it, so a host cannot claim another's.
    const features = [...msg.features.filter((f) => !f.startsWith("host/")), `host/${host}`];
    this.store.inventory(host, msg.capacity, features, this.version);
    const running = new Set(msg.running);
    const ended = new Set(msg.ended);
    for (const a of this.store.openAttempts(host)) {
      if (running.has(a.id) || ended.has(a.id)) continue;
      if (a.state === "assigned") this.store.giveBack(a.id, "host-reconnected-without-it");
      else this.store.fail(a.id, "lost-by-host");
    }
    for (const id of running) {
      if (this.store.started(id, host) === "stale") this.send(ws, { t: "cancel", attempt: id, reason: "not-yours" });
      else if (this.store.job(this.store.attempt(id)?.job ?? "")?.cancel_requested) this.send(ws, { t: "cancel", attempt: id, reason: "cancelled" });
    }
    this.store.emit("host.online", { host, data: { capacity: msg.capacity, features: msg.features } });
  }

  private onClose(ws: ServerWebSocket<Conn>): void {
    const host = ws.data.host;
    if (!host || this.online.get(host) !== ws) return;
    this.online.delete(host);
    for (const [token, name] of this.hostTokens) if (name === host) this.hostTokens.delete(token);
    if (!this.http) return;
    // Work the host never started goes back to the queue. Work it started stays with it.
    for (const a of this.store.openAttempts(host)) if (a.state === "assigned") this.store.giveBack(a.id, "host-disconnected");
    this.store.emit("host.offline", { host });
  }

  // ---- webhooks ------------------------------------------------------------

  private async pumpWebhooks(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (const sub of this.store.subscriptions()) {
        for (const ev of this.store.events(sub.cursor, 100)) {
          if (!sub.types.length || sub.types.includes(ev.type)) {
            const body = JSON.stringify(ev);
            const sig = createHmac("sha256", sub.secret).update(body).digest("hex");
            const res = await fetch(sub.url, {
              method: "POST",
              headers: { "content-type": "application/json", "x-cnoc-seq": String(ev.seq), "x-cnoc-signature": `sha256=${sig}` },
              body,
              signal: AbortSignal.timeout(10_000),
            }).catch(() => null);
            // Delivery is in order and at least once: stop at the first failure and retry later.
            if (!res?.ok) break;
          }
          if (!this.http) return;
          this.store.advance(sub.id, ev.seq);
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  // ---- HTTP ----------------------------------------------------------------

  private role(req: Request): { role: Role; actor: string } | null {
    const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (!token) return null;
    if (token === this.adminToken) return { role: "admin", actor: "admin" };
    const host = this.hostTokens.get(token);
    return host ? { role: "host", actor: `host:${host}` } : null;
  }

  private jobView(id: string): unknown {
    const j = this.store.job(id);
    if (!j) return null;
    return {
      id: j.id,
      state: j.state,
      reason: j.reason,
      pending_reason: j.state === "queued" ? (this.pending[j.id] ?? null) : j.state === "blocked" ? "dependency" : null,
      cancel_requested: j.cancel_requested,
      project: j.spec.project,
      priority: j.spec.priority,
      resources: j.spec.resources,
      requires: j.spec.requires,
      begin_at: j.spec.begin_at ?? null,
      depends: j.spec.depends,
      labels: j.spec.labels,
      submitted_at: j.submitted_at,
      updated_at: j.updated_at,
      host: this.store.openAttempt(j.id)?.host ?? null,
      result: j.result,
    };
  }

  private hostsView(): unknown[] {
    const reserved = this.store.reserved();
    return this.store.hosts().map((h) => ({
      ...h,
      fingerprint: fingerprint(h.pubkey),
      online: this.online.has(h.name),
      reserved: reserved.get(h.name) ?? {},
      running: this.store.openAttempts(h.name).map((a: AttemptRow) => ({ attempt: a.id, job: a.job, state: a.state })),
    }));
  }

  private async fetch(req: Request, server: BunServer<Conn>): Promise<Response | undefined> {
    const url = new URL(req.url);
    const path = url.pathname;
    const q = url.searchParams;
    const J = (body: unknown, status = 200) => Response.json(body, { status });
    try {
      if (path === "/v1/health") return J({ ok: true, version: this.version, protocol: PROTOCOL });
      if (path === "/v1/client") {
        if (server.upgrade(req, { data: { nonce: randomBytes(16).toString("base64url"), host: null } })) return undefined;
        return J({ error: "expected a websocket upgrade" }, 400);
      }
      const who = this.role(req);
      if (!who) return J({ error: "unauthorized" }, 401);
      const admin = () => {
        if (who.role !== "admin") throw new SubmitError("admin token required", 403);
      };
      const id = () => {
        const v = q.get("id");
        if (!v) throw new SubmitError("missing ?id=");
        return v;
      };
      const route = `${req.method} ${path}`;
      switch (route) {
        case "POST /v1/jobs": {
          const ct = req.headers.get("content-type") ?? "";
          const sent = ct.includes("json") ? ((await req.json()) as { jobs: string[]; overrides?: Overrides }) : { jobs: [await req.text()] };
          const bodies = sent.jobs;
          if (!Array.isArray(bodies) || bodies.some((b) => typeof b !== "string")) throw new SubmitError("expected { jobs: string[] }");
          const jobs = this.store.submit(bodies, who.actor, sent.overrides ?? {});
          return J({ jobs, seq: this.store.seq() });
        }
        case "GET /v1/jobs": {
          const states = q.get("state")?.split(",") as JobState[] | undefined;
          const all = q.get("all") === "1";
          const jobs = this.store
            .jobs(states)
            .filter((j) => all || states || !TERMINAL.includes(j.state))
            .filter((j) => !q.get("project") || j.spec.project === q.get("project"))
            .map((j) => this.jobView(j.id));
          return J({ as_of: this.store.seq(), jobs });
        }
        case "GET /v1/job": {
          const view = this.jobView(id());
          if (!view) return J({ error: "no such job" }, 404);
          return J({ as_of: this.store.seq(), job: view, body: this.store.job(id())?.body, attempts: this.store.attemptsOf(id()) });
        }
        case "POST /v1/job/cancel": {
          const { job, attempt } = this.store.cancel(id(), who.actor);
          if (attempt) {
            const ws = this.online.get(attempt.host);
            if (ws && attempt.state === "running") this.send(ws, { t: "cancel", attempt: attempt.id, reason: "cancelled" });
            else if (attempt.state === "assigned") this.store.giveBack(attempt.id, "cancelled");
          }
          return J({ job: this.jobView(job.id), seq: this.store.seq() });
        }
        case "POST /v1/job/requeue":
          return J({ job: this.jobView(this.store.requeue(id(), who.actor).id), seq: this.store.seq() });
        case "POST /v1/job/priority":
          return J({ job: this.jobView(this.store.setPriority(id(), Number(q.get("value") ?? Number.NaN), who.actor).id), seq: this.store.seq() });
        case "GET /v1/templates":
          return J({ templates: this.store.templates().map((t) => ({ ...t, body: undefined })) });
        case "POST /v1/templates": {
          admin();
          const b = (await req.json()) as { text?: string; source?: string };
          if (typeof b.text !== "string") throw new SubmitError("expected { text, source? }");
          return J({ ...this.store.templateAdd(b.text, b.source ?? null, who.actor), seq: this.store.seq() });
        }
        case "GET /v1/template": {
          const t = this.store.template(q.get("ref") ?? "", q.get("path") ?? undefined);
          if (!t) return J({ error: "no such template" }, 404);
          return J({ template: t });
        }
        case "DELETE /v1/template":
          admin();
          return J({ template: { ...this.store.templateRemove(q.get("ref") ?? "", q.get("path") ?? undefined, who.actor), body: undefined }, seq: this.store.seq() });
        case "POST /v1/template/run": {
          const b = (await req.json().catch(() => ({}))) as { set?: Record<string, string>; overrides?: Overrides };
          const set = b.set ?? {};
          if (typeof set !== "object" || Object.values(set).some((v) => typeof v !== "string")) throw new SubmitError("expected { set: { NAME: value } }");
          const r = this.store.templateRun(q.get("ref") ?? "", set, b.overrides ?? {}, who.actor);
          return J({ job: this.jobView(r.job), template: { ...r.template, body: undefined }, seq: this.store.seq() });
        }
        case "POST /v1/job/abandon": {
          // Gives up on a running attempt whose host is unreachable. The session may still
          // be alive there; if the host returns it is told to stop.
          admin();
          const a = this.store.openAttempt(id());
          if (!a) throw new SubmitError("job has no open attempt", 409);
          if (this.online.has(a.host)) throw new SubmitError(`host ${a.host} is online; cancel the job instead`, 409);
          this.store.fail(a.id, "abandoned", who.actor);
          return J({ job: this.jobView(id()), seq: this.store.seq() });
        }
        case "GET /v1/hosts":
          return J({ as_of: this.store.seq(), hosts: this.hostsView() });
        case "POST /v1/host/approve":
          admin();
          return J({ host: this.store.approve(q.get("name") ?? "", who.actor) });
        case "POST /v1/host/drain":
          admin();
          return J({ host: this.store.drain(q.get("name") ?? "", q.get("on") !== "0", who.actor) });
        case "GET /v1/state":
          return J({
            as_of: this.store.seq(),
            version: this.version,
            pools: this.poolState(),
            hosts: this.hostsView(),
            jobs: this.store.jobs().filter((j) => !TERMINAL.includes(j.state)).map((j) => this.jobView(j.id)),
          });
        case "GET /v1/events": {
          const after = Number(q.get("after") ?? 0);
          const wait = Math.min(Number(q.get("wait") ?? 0), 60);
          let events = this.store.events(after, Number(q.get("limit") ?? 500));
          if (events.length === 0 && wait > 0) {
            await new Promise<void>((done) => {
              const off = this.store.onEvent(() => {
                clearTimeout(timer);
                off();
                done();
              });
              const timer = setTimeout(() => {
                off();
                done();
              }, wait * 1000);
            });
            if (!this.http) return J({ events: [], next: after });
            events = this.store.events(after, Number(q.get("limit") ?? 500));
          }
          return J({ events, next: events.at(-1)?.seq ?? after });
        }
        case "GET /v1/events/stream":
          return this.stream(Number(q.get("after") ?? req.headers.get("last-event-id") ?? 0));
        case "GET /v1/subscriptions":
          admin();
          return J({ subscriptions: this.store.subscriptions().map((s) => ({ ...s, secret: undefined })) });
        case "POST /v1/subscriptions": {
          admin();
          const b = (await req.json()) as { url?: string; types?: string[]; secret?: string; after?: number };
          if (!b.url || !/^https?:\/\//.test(b.url)) throw new SubmitError("url is required");
          const secret = b.secret ?? randomBytes(24).toString("base64url");
          const sub = this.store.subscribe(b.url, b.types ?? [], secret, b.after ?? this.store.seq());
          return J({ subscription: sub });
        }
        case "DELETE /v1/subscriptions":
          admin();
          this.store.unsubscribe(Number(id()));
          return J({ ok: true });
      }
      return J({ error: `no route: ${route}` }, 404);
    } catch (e) {
      if (e instanceof SubmitError) return J({ error: e.message }, e.status);
      this.log(`error on ${req.method} ${path}: ${(e as Error).stack ?? e}`);
      return J({ error: "internal error" }, 500);
    }
  }

  /** Server-sent events, resumable with ?after= or Last-Event-ID. */
  private stream(after: number): Response {
    let cursor = after;
    let off = () => {};
    let keepalive: Timer | undefined;
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start: (ctl) => {
        const flush = () => {
          let batch: ChangeEvent[];
          try {
            batch = this.store.events(cursor, 500);
          } catch {
            return;
          }
          for (const ev of batch) {
            ctl.enqueue(enc.encode(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`));
            cursor = ev.seq;
          }
        };
        flush();
        off = this.store.onEvent(flush);
        keepalive = setInterval(() => ctl.enqueue(enc.encode(": keepalive\n\n")), 20_000);
      },
      cancel: () => {
        off();
        clearInterval(keepalive);
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  }
}
