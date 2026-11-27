/**
 * The per-host client. It opens one outbound WebSocket to the server, reports what the
 * host has and what it is running, starts the work it is handed, and serves a local
 * socket the harness uses to report back.
 *
 * It starts nothing while it cannot reach the server. Work already started keeps running
 * and its result waits in an outbox until the server acknowledges it.
 */
import { type KeyObject, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { arch, cpus, freemem, homedir, loadavg, platform, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { type Adapter, parseAdapter } from "../jobfile";
import type { AttemptEnd, ClientMsg, Measured, Resources, ServerMsg, StageResult } from "../protocol";
import { PROTOCOL } from "../protocol";
import { APP_ROOT, runningVersion, runningVersionProblem } from "../version";
import { AttemptRunner, type AttemptState } from "./runner";
import { Tmux } from "./tmux";
import { Updater } from "./update";

export interface ClientConfig {
  /** http(s)://host:port of the server. */
  server: string;
  name: string;
  /** Project name -> local checkout. A job's FROM is resolved here. */
  projects: Record<string, string>;
  /** Named counters this host offers. Default { slots: 1 }. */
  resources?: Resources;
  features?: string[];
  /** Decline new work while the 1-minute load average per CPU is above this. */
  max_load?: number;
  /** Extra directory of <name>.harness adapters, searched before the built-in ones. */
  harness_dir?: string;
  /**
   * Shell command run instead of the built-in update when the server's version differs, with
   * `CNOC_TARGET_VERSION` set. For installs that are not a git checkout. See client/update.ts.
   */
  update?: string;
}

export interface ClientOptions {
  config: ClientConfig;
  stateDir: string;
  tmuxSocket?: string;
  version?: string;
  /** The checkout the built-in update moves. Default: the one this code runs from. */
  checkout?: string;
  pollMs?: number;
  /** Replaces process.exit after an update, for tests. */
  exit?: (code: number) => void;
  log?: (line: string) => void;
}

const BUILTIN_HARNESS_DIR = resolve(import.meta.dir, "../../harness");
const CLI_ENTRY = resolve(import.meta.dir, "../cli.ts");
/** WebSocket close code the server uses when a newer connection takes over a host's identity. */
export const REPLACED = 4001;
/** While an update waits out its backoff, the server is still asked this often whether its version changed. */
const MISMATCH_RECHECK_MS = 5 * 60_000;
const expandHome = (p: string): string => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

export class CnocClient {
  private static active = new Set<string>();
  readonly tmux: Tmux;
  readonly sockPath: string;
  readonly version: string;
  private ws: WebSocket | null = null;
  private connected = false;
  private stopped = false;
  private apiToken: string | null = null;
  private retryMs = 500;
  private timers = new Set<Timer>();
  private heartbeat: Timer | null = null;
  private local: ReturnType<typeof Bun.serve> | null = null;
  private runners = new Map<number, AttemptRunner>();
  private outbox: AttemptEnd[] = [];
  private key: KeyObject;
  private pubkey: string;
  private log: (line: string) => void;
  private updater: Updater;

  constructor(private opts: ClientOptions) {
    const dir = opts.stateDir;
    mkdirSync(join(dir, "logs"), { recursive: true });
    mkdirSync(join(dir, "bin"), { recursive: true });
    chmodSync(dir, 0o700);
    this.version = opts.version ?? runningVersion();
    this.log = opts.log ?? ((l) => console.log(`[client ${opts.config.name}] ${l}`));
    const problem = opts.version === undefined ? runningVersionProblem() : null;
    if (problem) this.log(`WARNING: ${problem}`);
    this.updater = new Updater({
      checkout: opts.checkout ?? APP_ROOT,
      stateDir: dir,
      version: this.version,
      command: opts.config.update,
      log: this.log,
    });
    this.tmux = new Tmux(opts.tmuxSocket ?? "cnoc");
    this.sockPath = join(dir, "sock");

    const keyFile = join(dir, "host.key");
    if (!existsSync(keyFile)) {
      const { privateKey } = generateKeyPairSync("ed25519");
      writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    }
    this.key = createPrivateKey(readFileSync(keyFile));
    this.pubkey = createPublicKey(this.key).export({ type: "spki", format: "der" }).toString("base64");

    // The harness calls `cnoc done` and friends; this puts that command on its PATH.
    const shim = join(dir, "bin", "cnoc");
    writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${CLI_ENTRY}" "$@"\n`, { mode: 0o755 });

    this.outbox = this.readJson<AttemptEnd[]>("outbox.json", []);
  }

  // ---- persistence ---------------------------------------------------------

  private readJson<T>(name: string, fallback: T): T {
    try {
      return JSON.parse(readFileSync(join(this.opts.stateDir, name), "utf8")) as T;
    } catch {
      return fallback;
    }
  }

  private writeJson(name: string, value: unknown): void {
    const file = join(this.opts.stateDir, name);
    writeFileSync(`${file}.tmp`, JSON.stringify(value));
    renameSync(`${file}.tmp`, file);
  }

  private save = (): void => {
    this.writeJson(
      "attempts.json",
      [...this.runners.values()].map((r) => r.state),
    );
    this.writeJson("outbox.json", this.outbox);
  };

  // ---- what this host offers -----------------------------------------------

  adapter = (name: string): Adapter | null => {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;
    for (const dir of [this.opts.config.harness_dir, BUILTIN_HARNESS_DIR]) {
      if (!dir) continue;
      const file = join(expandHome(dir), `${name}.harness`);
      if (existsSync(file)) return parseAdapter(readFileSync(file, "utf8"));
    }
    return null;
  };

  private harnesses(): string[] {
    const names = new Set<string>();
    for (const dir of [this.opts.config.harness_dir, BUILTIN_HARNESS_DIR]) {
      if (!dir || !existsSync(expandHome(dir))) continue;
      for (const f of readdirSync(expandHome(dir)))
        if (f.endsWith(".harness")) names.add(f.slice(0, -".harness".length));
    }
    return [...names].filter((n) => {
      try {
        return (this.adapter(n)?.requires ?? []).every((bin) => Bun.which(bin) !== null);
      } catch (e) {
        this.log(`harness ${n} is not usable: ${(e as Error).message}`);
        return false;
      }
    });
  }

  private projectPath = (name: string): string | null => {
    const p = this.opts.config.projects[name];
    if (!p) return null;
    const full = expandHome(p);
    return existsSync(full) ? full : null;
  };

  private capacity(): Resources {
    return this.opts.config.resources ?? { slots: 1 };
  }

  private features(): string[] {
    return [
      platform(),
      arch(),
      ...(this.opts.config.features ?? []),
      ...Object.keys(this.opts.config.projects)
        .filter((p) => this.projectPath(p))
        .map((p) => `project/${p}`),
      ...this.harnesses().map((h) => `harness/${h}`),
    ];
  }

  private reserved(): Resources {
    const out: Resources = {};
    for (const r of this.runners.values())
      for (const [n, v] of Object.entries(r.state.spec.resources)) out[n] = (out[n] ?? 0) + v;
    return out;
  }

  private measured(): Measured {
    return { cpus: cpus().length, load1: loadavg()[0] ?? 0, mem_total: totalmem(), mem_free: freemem() };
  }

  // ---- lifecycle -----------------------------------------------------------

  /**
   * Two clients sharing one identity would each tell the server the other's sessions are
   * gone. One state directory, one process.
   */
  private lock(): void {
    const file = join(this.opts.stateDir, "client.pid");
    const other = Number(this.readText(file));
    if (other && other !== process.pid) {
      let alive = true;
      try {
        process.kill(other, 0);
      } catch {
        alive = false;
      }
      if (alive) throw new Error(`another cnoc client (pid ${other}) is already using ${this.opts.stateDir}`);
    }
    if (CnocClient.active.has(this.opts.stateDir))
      throw new Error(`another cnoc client in this process is already using ${this.opts.stateDir}`);
    CnocClient.active.add(this.opts.stateDir);
    writeFileSync(file, String(process.pid));
  }

  private readText(file: string): string {
    try {
      return readFileSync(file, "utf8").trim();
    } catch {
      return "";
    }
  }

  async start(): Promise<this> {
    this.lock();
    rmSync(this.sockPath, { force: true });
    this.local = Bun.serve({ unix: this.sockPath, fetch: (req) => this.localFetch(req) });
    chmodSync(this.sockPath, 0o600);
    // Pick up whatever was running when the previous process stopped.
    for (const state of this.readJson<AttemptState[]>("attempts.json", [])) this.launch(state, true);
    this.connect();
    return this;
  }

  /** Stops the client. Sessions are left running on purpose; the next start re-adopts them. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.ws?.close();
    await this.local?.stop(true);
    this.local = null;
    if (CnocClient.active.delete(this.opts.stateDir)) rmSync(join(this.opts.stateDir, "client.pid"), { force: true });
  }

  get running(): number[] {
    return [...this.runners.keys()];
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.stopped) fn();
    }, ms);
    this.timers.add(t);
  }

  // ---- server connection ---------------------------------------------------

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(`${this.opts.config.server.replace(/^http/, "ws")}/v1/client`);
    this.ws = ws;
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      try {
        this.onMessage(JSON.parse(String(ev.data)) as ServerMsg);
      } catch (e) {
        this.log(`error handling server message: ${(e as Error).message}`);
      }
    };
    ws.onerror = () => {};
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (ev.code === REPLACED) {
        // Reconnecting would only knock the other one off in turn.
        this.log("another client connected to the server as this host; backing off for 5 minutes");
        this.retryMs = 300_000;
      } else if (this.connected) this.log("disconnected from server");
      this.connected = false;
      this.apiToken = null;
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.later(this.retryMs, () => this.connect());
      this.retryMs = Math.min(Math.max(this.retryMs, 500) * 2, 30_000);
    };
  }

  private send(msg: ClientMsg): void {
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private onMessage(msg: ServerMsg): void {
    switch (msg.t) {
      case "challenge": {
        const mismatch = msg.version !== this.version || msg.protocol !== PROTOCOL;
        const sig = sign(null, Buffer.from(`cnoc-hello\n${this.opts.config.name}\n${msg.nonce}`), this.key).toString(
          "base64",
        );
        this.ws?.send(
          JSON.stringify({
            t: "hello",
            name: this.opts.config.name,
            pubkey: this.pubkey,
            sig,
            version: this.version,
            protocol: PROTOCOL,
            // The server will refuse it, but can show the host's version and why it has not caught up.
            ...(mismatch ? { update: this.updater.note(msg.version) } : {}),
          } satisfies ClientMsg),
        );
        if (mismatch) this.onMismatch(msg.version);
        return;
      }
      case "pending":
        this.retryMs = Math.max(this.retryMs, 5000);
        {
          this.log(
            `waiting for approval (key ${msg.fingerprint}). On the server: cnoc hosts approve ${this.opts.config.name}`,
          );
          return;
        }
      case "welcome":
        this.connected = true;
        this.apiToken = msg.api_token;
        this.retryMs = 500;
        this.updater.clear();
        this.log(`connected as ${msg.host}`);
        this.send({
          t: "sync",
          capacity: this.capacity(),
          features: this.features(),
          running: this.running,
          ended: this.outbox.map((e) => e.attempt),
        });
        for (const end of this.outbox) this.send({ t: "ended", ...end });
        this.heartbeat = setInterval(
          () => this.send({ t: "status", measured: this.measured(), reserved: this.reserved(), running: this.running }),
          msg.heartbeat_s * 1000,
        );
        this.send({ t: "status", measured: this.measured(), reserved: this.reserved(), running: this.running });
        return;
      case "assign": {
        this.onAssign(msg);
        return;
      }
      case "cancel": {
        this.runners.get(msg.attempt)?.cancel(msg.reason);
        return;
      }
      case "ack":
        this.outbox = this.outbox.filter((e) => e.attempt !== msg.attempt);
        {
          this.save();
          return;
        }
    }
  }

  /**
   * The server runs a different version: take no work, update to it, and exit so the service
   * manager starts the new code. Between tries the server is asked again only when one is due.
   */
  private onMismatch(serverVersion: string): void {
    this.ws?.close();
    const wait = this.updater.dueIn(serverVersion);
    this.retryMs = Math.max(this.retryMs, Math.min(Math.max(wait, 5000), MISMATCH_RECHECK_MS));
    if (wait > 0) return;
    void this.updater
      .attempt(serverVersion)
      .then(async (restart) => {
        if (!restart) return;
        await this.stop();
        (this.opts.exit ?? process.exit)(75);
      })
      .catch((e: Error) => this.log(`update failed: ${e.message}`));
  }

  private onAssign(msg: Extract<ServerMsg, { t: "assign" }>): void {
    const { spec } = msg;
    const decline = (reason: string) => this.send({ t: "decline", attempt: msg.attempt, reason });
    if (!this.projectPath(spec.project)) {
      decline(`project ${spec.project} is not on this host`);
      return;
    }
    for (const s of spec.stages)
      if (!this.adapter(s.harness)) {
        decline(`no adapter for harness ${s.harness}`);
        return;
      }
    const cap = this.capacity();
    const held = this.reserved();
    for (const [n, v] of Object.entries(spec.resources)) {
      if (n in cap && (held[n] ?? 0) + v > (cap[n] ?? 0)) {
        decline(`not enough ${n}`);
        return;
      }
    }
    const m = this.measured();
    const ceiling = this.opts.config.max_load;
    if (ceiling !== undefined && m.cpus > 0 && m.load1 / m.cpus > ceiling) {
      decline(`load ${(m.load1 / m.cpus).toFixed(2)} is above ${ceiling}`);
      return;
    }
    this.launch(
      {
        attempt: msg.attempt,
        spec,
        token: randomBytes(24).toString("base64url"),
        stage: 0,
        phase: "launching",
        deadline: spec.time_s ? Date.now() + spec.time_s * 1000 : null,
        results: [],
        reported: null,
      },
      false,
    );
  }

  private launch(state: AttemptState, resuming: boolean): void {
    const runner = new AttemptRunner(
      state,
      {
        tmux: this.tmux,
        adapter: this.adapter,
        projectPath: this.projectPath,
        baseEnv: { CNOC_SOCK: this.sockPath, PATH: `${join(this.opts.stateDir, "bin")}:${process.env.PATH ?? ""}` },
        save: this.save,
        onStarted: (attempt) => this.send({ t: "started", attempt }),
        writeLog: (attempt, stage, text) =>
          writeFileSync(join(this.opts.stateDir, "logs", `${attempt}-${stage + 1}.log`), text),
        pollMs: this.opts.pollMs ?? 1000,
      },
      resuming,
    );
    this.runners.set(state.attempt, runner);
    this.save();
    this.log(`${resuming ? "resuming" : "starting"} attempt ${state.attempt} (${state.spec.id})`);
    void runner
      .run()
      .catch(
        (e): AttemptEnd => ({
          attempt: state.attempt,
          outcome: "failed",
          reason: `client error: ${(e as Error).message}`,
          results: state.results,
        }),
      )
      .then((end) => {
        this.runners.delete(state.attempt);
        this.outbox.push(end);
        this.save();
        this.log(`attempt ${end.attempt} ${end.outcome}${end.reason ? ` (${end.reason})` : ""}`);
        this.send({ t: "ended", ...end });
      });
  }

  // ---- local API for the harness -------------------------------------------

  private async localFetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    const runner = [...this.runners.values()].find((r) => r.state.token === token);
    if (!token || !runner) return Response.json({ error: "unknown or finished attempt" }, { status: 401 });

    if (url.pathname === "/attempt/progress" && req.method === "POST") {
      const { note } = (await req.json()) as { note?: string };
      this.send({
        t: "progress",
        attempt: runner.state.attempt,
        stage: runner.state.stage + 1,
        note: String(note ?? ""),
      });
      return Response.json({ ok: true, delivered: this.connected });
    }
    if (url.pathname === "/attempt/result" && req.method === "POST") {
      const b = (await req.json()) as Partial<StageResult>;
      if (b.status !== "done" && b.status !== "failed")
        return Response.json({ error: "status must be done or failed" }, { status: 400 });
      const accepted = runner.report({ status: b.status, summary: String(b.summary ?? ""), data: b.data });
      return Response.json({ ok: true, accepted });
    }
    if (url.pathname.startsWith("/v1/")) {
      // A job may talk to the server (to submit follow-up jobs, say) without holding any credential of its own.
      if (!this.connected || !this.apiToken)
        return Response.json({ error: "client is not connected to the server" }, { status: 503 });
      const headers = new Headers(req.headers);
      headers.set("authorization", `Bearer ${this.apiToken}`);
      headers.delete("host");
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
      return fetch(`${this.opts.config.server}${url.pathname}${url.search}`, { method: req.method, headers, body });
    }
    return Response.json({ error: "no such route" }, { status: 404 });
  }
}

export function loadClientConfig(file: string): ClientConfig {
  const cfg = JSON.parse(readFileSync(expandHome(file), "utf8")) as Partial<ClientConfig>;
  if (!cfg.server || !cfg.name) throw new Error(`${file}: "server" and "name" are required`);
  return { projects: {}, ...cfg } as ClientConfig;
}
