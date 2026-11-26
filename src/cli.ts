#!/usr/bin/env bun
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CnocClient, loadClientConfig } from "./client/client";
import { JobfileError, parseJob } from "./jobfile";
import { type ChangeEvent, PROTOCOL, VERSION } from "./protocol";
import { CnocServer, type ServerOptions } from "./server/server";

const HELP = `cnoc ${VERSION} - batch scheduling of agent harness sessions across persistent hosts

Run the services
  cnoc server [--data DIR] [--port 7878] [--host 127.0.0.1] [--config FILE] [--open-enrollment]
  cnoc client [--config ~/.config/cnoc/client.json] [--state ~/.local/state/cnoc]
  cnoc ingest DIR [--interval SECONDS]     submit every *.job under DIR/jobs, pulling DIR first if it is a git checkout

Jobs
  cnoc check FILE...                       validate Jobfiles without a server
  cnoc submit FILE...                      submit as one atomic batch
  cnoc queue [--all] [--json]              what is waiting and running
  cnoc show ID [--json]
  cnoc cancel ID | requeue ID | abandon ID

Hosts
  cnoc hosts [--json]
  cnoc hosts approve NAME | drain NAME | undrain NAME
  cnoc attach ATTEMPT [STAGE]              read-only view of a session on this host

Changelog
  cnoc events [--after SEQ] [--follow] [--json]

Inside a job (the harness calls these)
  cnoc progress "note"
  cnoc done "summary"
  cnoc fail "reason"

Connection: CNOC_URL and CNOC_TOKEN, or ~/.config/cnoc/cli.json { "url", "token" }.
Inside a job the client's local socket is used and no credential is needed.`;

function parseArgs(argv: string[]): { pos: string[]; flags: Record<string, string | true> } {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith("--")) {
      pos.push(a);
      continue;
    }
    const [k, inline] = a.slice(2).split("=", 2) as [string, string | undefined];
    const next = argv[i + 1];
    if (inline !== undefined) flags[k] = inline;
    else if (next !== undefined && !next.startsWith("--") && !BOOLEAN.has(k)) flags[k] = argv[++i] as string;
    else flags[k] = true;
  }
  return { pos, flags };
}
const BOOLEAN = new Set(["all", "json", "follow", "open-enrollment", "help"]);
const home = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
const str = (v: string | true | undefined, fallback: string): string => (typeof v === "string" ? v : fallback);

class CliError extends Error {}

/** Calls the server: through the client's local socket inside a job, directly otherwise. */
async function api(method: string, path: string, body?: unknown, contentType = "application/json"): Promise<any> {
  const sock = process.env.CNOC_SOCK;
  let base: string;
  let token: string | undefined;
  let unix: string | undefined;
  if (sock && process.env.CNOC_TOKEN) {
    [base, token, unix] = ["http://localhost", process.env.CNOC_TOKEN, sock];
  } else {
    const file = home("~/.config/cnoc/cli.json");
    const cfg = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { url?: string; token?: string }) : {};
    base = process.env.CNOC_URL ?? cfg.url ?? "http://127.0.0.1:7878";
    token = process.env.CNOC_TOKEN ?? cfg.token;
    if (!token) throw new CliError("no credentials: set CNOC_TOKEN or write ~/.config/cnoc/cli.json");
  }
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": contentType } : {}) },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    ...(unix ? { unix } : {}),
  } as RequestInit).catch((e: Error) => {
    throw new CliError(`cannot reach ${unix ?? base}: ${e.message}`);
  });
  const out = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new CliError(out.error ?? `${res.status} ${res.statusText}`);
  return out;
}

function table(rows: string[][]): string {
  const widths = rows[0]?.map((_, c) => Math.max(...rows.map((r) => (r[c] ?? "").length))) ?? [];
  return rows.map((r) => r.map((cell, c) => cell.padEnd(widths[c] ?? 0)).join("  ").trimEnd()).join("\n");
}

const age = (ms: number): string => {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
};

function jobFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".job")) out.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

function printEvent(e: ChangeEvent): void {
  const who = [e.job, e.attempt !== null ? `#${e.attempt}` : null, e.host ? `@${e.host}` : null].filter(Boolean).join(" ");
  const data = e.data && Object.keys(e.data as object).length ? ` ${JSON.stringify(e.data)}` : "";
  console.log(`${String(e.seq).padStart(6)}  ${new Date(e.ts).toISOString().slice(11, 19)}  ${e.type.padEnd(22)} ${who}${data}`);
}

async function report(status: "done" | "failed", summary: string): Promise<void> {
  if (!process.env.CNOC_SOCK) throw new CliError("not inside a Cnoc job (CNOC_SOCK is not set)");
  const r = await api("POST", "/attempt/result", { status, summary });
  console.log(r.accepted ? `reported ${status}` : "a result was already reported for this stage");
}

async function main(): Promise<void> {
  const [cmd = "help", ...rest] = process.argv.slice(2);
  const { pos, flags } = parseArgs(rest);
  const asJson = flags.json === true;
  const need = (i: number, what: string): string => {
    const v = pos[i];
    if (!v) throw new CliError(`missing ${what}`);
    return v;
  };

  switch (cmd) {
    case "help":
    case "--help":
    case "-h":
      return console.log(HELP);
    case "version":
    case "--version":
      return console.log(`${VERSION} (protocol ${PROTOCOL})`);

    case "server": {
      const file = typeof flags.config === "string" ? (JSON.parse(readFileSync(home(flags.config), "utf8")) as Partial<ServerOptions>) : {};
      const server = await new CnocServer({
        ...file,
        dataDir: home(str(flags.data, file.dataDir ?? "~/.local/share/cnoc")),
        port: Number(str(flags.port, String(file.port ?? 7878))),
        hostname: str(flags.host, file.hostname ?? "127.0.0.1"),
        openEnrollment: flags["open-enrollment"] === true || file.openEnrollment === true,
      }).start();
      console.log(`[server] cnoc ${server.version} listening on ${server.url}`);
      console.log(`[server] admin token: ${join(home(str(flags.data, file.dataDir ?? "~/.local/share/cnoc")), "admin.token")}`);
      process.on("SIGINT", () => void server.stop().then(() => process.exit(0)));
      process.on("SIGTERM", () => void server.stop().then(() => process.exit(0)));
      return;
    }

    case "client": {
      const config = loadClientConfig(str(flags.config, "~/.config/cnoc/client.json"));
      const client = await new CnocClient({ config, stateDir: home(str(flags.state, "~/.local/state/cnoc")) }).start();
      process.on("SIGINT", () => void client.stop().then(() => process.exit(0)));
      process.on("SIGTERM", () => void client.stop().then(() => process.exit(0)));
      return;
    }

    case "check": {
      let bad = 0;
      for (const f of pos) {
        try {
          const spec = parseJob(readFileSync(f, "utf8"));
          console.log(`ok    ${f}  (${spec.id}, ${spec.stages.length} stage${spec.stages.length === 1 ? "" : "s"})`);
        } catch (e) {
          if (!(e instanceof JobfileError)) throw e;
          bad++;
          console.log(`FAIL  ${f}  ${e.message}`);
        }
      }
      if (pos.length === 0) throw new CliError("missing FILE");
      if (bad) process.exit(1);
      return;
    }

    case "submit": {
      need(0, "FILE");
      const r = await api("POST", "/v1/jobs", { jobs: pos.map((f) => readFileSync(f, "utf8")) });
      for (const j of r.jobs) console.log(`${j.created ? "submitted" : "unchanged"}  ${j.id}  ${j.state}`);
      return;
    }

    case "ingest": {
      const dir = home(need(0, "DIR"));
      const interval = Number(str(flags.interval, "0"));
      for (;;) {
        if (existsSync(join(dir, ".git"))) {
          const pull = Bun.spawnSync(["git", "-C", dir, "pull", "--ff-only", "--quiet"], { stderr: "pipe" });
          if (pull.exitCode !== 0) console.error(`[ingest] git pull failed: ${pull.stderr.toString().trim()}`);
        }
        const files = jobFiles(join(dir, "jobs"));
        const bodies = files.map((f) => readFileSync(f, "utf8"));
        try {
          const r = await api("POST", "/v1/jobs", { jobs: bodies });
          for (const j of r.jobs) if (j.created) console.log(`[ingest] submitted ${j.id} (${j.state})`);
        } catch (batchError) {
          // One bad file must not hold back the rest: fall back to one at a time.
          console.error(`[ingest] batch refused: ${(batchError as Error).message}`);
          for (const [i, body] of bodies.entries()) {
            try {
              const r = await api("POST", "/v1/jobs", { jobs: [body] });
              if (r.jobs[0]?.created) console.log(`[ingest] submitted ${r.jobs[0].id} (${r.jobs[0].state})`);
            } catch (e) {
              console.error(`[ingest] ${files[i]}: ${(e as Error).message}`);
            }
          }
        }
        if (!interval) return;
        await Bun.sleep(interval * 1000);
      }
    }

    case "queue": {
      const r = await api("GET", `/v1/jobs${flags.all ? "?all=1" : ""}`);
      if (asJson) return console.log(JSON.stringify(r, null, 2));
      if (r.jobs.length === 0) return console.log("nothing queued or running");
      const rows = [["JOB", "STATE", "HOST", "PRIO", "AGE", "WHY"]];
      for (const j of r.jobs) rows.push([j.id, j.state, j.host ?? "-", String(j.priority), age(j.submitted_at), j.reason ?? j.pending_reason ?? ""]);
      return console.log(table(rows));
    }

    case "show": {
      const r = await api("GET", `/v1/job?id=${encodeURIComponent(need(0, "ID"))}`);
      if (asJson) return console.log(JSON.stringify(r, null, 2));
      const j = r.job;
      console.log(`${j.id}  ${j.state}${j.reason ? `  (${j.reason})` : ""}${j.pending_reason ? `  waiting: ${j.pending_reason}` : ""}`);
      console.log(`project ${j.project}  priority ${j.priority}  resources ${JSON.stringify(j.resources)}  depends ${JSON.stringify(j.depends)}`);
      for (const a of r.attempts) console.log(`  attempt ${a.id} on ${a.host}: ${a.state}${a.outcome ? ` ${a.outcome}` : ""}${a.reason ? ` (${a.reason})` : ""}`);
      for (const [i, s] of ((j.result as Array<{ status: string; summary: string }> | null) ?? []).entries()) console.log(`  stage ${i + 1}: ${s.status}  ${s.summary}`);
      return;
    }

    case "cancel":
    case "requeue":
    case "abandon": {
      const r = await api("POST", `/v1/job/${cmd}?id=${encodeURIComponent(need(0, "ID"))}`);
      return console.log(`${r.job.id}  ${r.job.state}${r.job.cancel_requested ? "  (cancel requested)" : ""}`);
    }

    case "hosts": {
      if (pos[0] === "approve") return console.log(`approved ${(await api("POST", `/v1/host/approve?name=${encodeURIComponent(need(1, "NAME"))}`)).host.name}`);
      const r = await api("GET", "/v1/hosts");
      if (asJson) return console.log(JSON.stringify(r, null, 2));
      if (r.hosts.length === 0) return console.log("no hosts have connected");
      const rows = [["HOST", "STATUS", "RUNNING", "RESERVED / CAPACITY", "LOAD", "KEY"]];
      for (const h of r.hosts) {
        const status = h.status === "pending" ? "pending" : h.drained ? "drained" : h.online ? "online" : "offline";
        const res = Object.keys(h.capacity).map((n: string) => `${n} ${h.reserved[n] ?? 0}/${h.capacity[n]}`).join(", ");
        const load = h.measured ? (h.measured.load1 / Math.max(1, h.measured.cpus)).toFixed(2) : "-";
        rows.push([h.name, status, String(h.running.length), res || "-", load, h.fingerprint]);
      }
      return console.log(table(rows));
    }
    case "drain":
    case "undrain": {
      const r = await api("POST", `/v1/host/drain?name=${encodeURIComponent(need(0, "NAME"))}&on=${cmd === "drain" ? 1 : 0}`);
      return console.log(`${r.host.name}  ${r.host.drained ? "drained" : "accepting work"}`);
    }

    case "attach": {
      const session = `cnoc-${need(0, "ATTEMPT")}-${Number(pos[1] ?? 1) - 1}`;
      const p = Bun.spawn(["tmux", "-L", process.env.CNOC_TMUX_SOCKET ?? "cnoc", "attach", "-r", "-t", `=${session}`], { stdio: ["inherit", "inherit", "inherit"] });
      process.exit(await p.exited);
      return;
    }

    case "events": {
      let after = Number(str(flags.after, "0"));
      for (;;) {
        const r = await api("GET", `/v1/events?after=${after}&wait=${flags.follow ? 30 : 0}`);
        for (const e of r.events as ChangeEvent[]) asJson ? console.log(JSON.stringify(e)) : printEvent(e);
        after = r.next;
        if (!flags.follow && r.events.length === 0) return;
      }
    }

    case "progress": {
      if (!process.env.CNOC_SOCK) throw new CliError("not inside a Cnoc job (CNOC_SOCK is not set)");
      await api("POST", "/attempt/progress", { note: pos.join(" ") });
      return;
    }
    case "done":
      return report("done", pos.join(" "));
    case "fail":
      return report("failed", pos.join(" "));

    default:
      throw new CliError(`unknown command: ${cmd}\n\n${HELP}`);
  }
}

main().catch((e) => {
  if (e instanceof CliError) console.error(`cnoc: ${e.message}`);
  else console.error(e);
  process.exit(1);
});
