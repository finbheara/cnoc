#!/usr/bin/env bun
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CnocClient, loadClientConfig } from "./client/client";
import { feedCommand } from "./feed";
import { JobfileError, checkTemplate, isTemplate, parseJob } from "./jobfile";
import { type ChangeEvent, type Overrides, PROTOCOL } from "./protocol";
import { ReportError, parseHandoff, progress, report, snapshot } from "./report";
import { CnocServer, type HostInfo, type JobInfo, type ServerOptions } from "./server/server";
import type { AttemptRow, TemplateRow } from "./server/store";
import { formatUsage } from "./usage";
import { printable, runningVersion, shortVersion } from "./version";

const HELP = `cnoc - batch scheduling of agent harness sessions across persistent hosts

Run the services
  cnoc server [--data DIR] [--port 7878] [--host 127.0.0.1] [--config FILE] [--open-enrollment]
  cnoc client [--config ~/.config/cnoc/client.json] [--state ~/.local/state/cnoc]
  cnoc ingest DIR [--interval SECONDS]     submit every *.job under DIR/jobs, pulling DIR first if it is a git checkout
  cnoc feed [--every DUR] [--max 10] [--dry-run] -- COMMAND...
                                           submit each line COMMAND prints as a keyed template run (cnoc feed --help)

Jobs
  cnoc check FILE...                       validate Jobfiles and templates without a server
  cnoc submit FILE... [WHEN AND WHERE]     submit as one atomic batch
  cnoc queue [--all] [--json]              what is waiting and running
  cnoc show ID [--json]
  cnoc cancel ID | requeue ID | abandon ID
  cnoc priority ID N                       move a job that has not been dispatched; higher goes first

Templates (cnoc t is short for cnoc template)
  cnoc template add FILE...                save a Jobfile so it can be started again and again
  cnoc template list
  cnoc template show REF
  cnoc template run REF [--set NAME=VALUE]... [--key KEY] [WHEN AND WHERE]
  cnoc template rm REF                     REF is the number, the name, or the file it was added from

When and where, for submit and template run
  --on HOST                                only this host
  --priority N                             higher goes first; a running job is never interrupted
  --at TIME                                not before this local time: 03:00, or 2027-01-31T03:00
  --after DURATION                         not before this long from now: 90m, 2h

Hosts
  cnoc hosts [--json]                      with the version each runs and why one has not caught up
  cnoc hosts approve NAME | drain NAME | undrain NAME
  cnoc attach ATTEMPT [STAGE]              read-only view of a session on this host

Changelog
  cnoc events [--after SEQ] [--follow] [--json]

Inside a job (the harness calls these)
  cnoc progress "note"
  cnoc done "summary"
  cnoc fail "reason"
  cnoc handoff MERGED [-m "note"]          done, recording how the work was left
  cnoc handoff BLOCKED -m "reason"         failed, recording how the work was left
  cnoc usage                               record token usage so far without ending; for a Stop hook

Connection: CNOC_URL and CNOC_TOKEN, or ~/.config/cnoc/cli.json { "url", "token" }.
Inside a job the client's local socket is used and no credential is needed.`;

function parseArgs(argv: string[]): { pos: string[]; flags: Record<string, string | true>; sets: string[] } {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  /** Every value of --set, which may be given more than once. */
  const sets: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith("--")) {
      pos.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const [k, inline] = eq < 0 ? [a.slice(2), undefined] : [a.slice(2, eq), a.slice(eq + 1)];
    const next = argv[i + 1];
    if (inline !== undefined) flags[k] = inline;
    else if (next !== undefined && !next.startsWith("--") && !BOOLEAN.has(k)) flags[k] = argv[++i] as string;
    else flags[k] = true;
    if (k === "set" && typeof flags[k] === "string") sets.push(flags[k] as string);
  }
  return { pos, flags, sets };
}
const BOOLEAN = new Set(["all", "json", "follow", "open-enrollment", "help"]);
const home = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
const str = (v: string | true | undefined, fallback: string): string => (typeof v === "string" ? v : fallback);

class CliError extends Error {
  /** The HTTP status, when the server answered. */
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Calls the server: through the client's local socket inside a job, directly otherwise. */
/** What the server answers to a submission. */
type Submitted = { jobs: Array<{ id: string; state: string; created: boolean }> };
type OneJob = { job: JobInfo };
/** A template as listed: everything but its text. */
type TemplateInfo = Omit<TemplateRow, "body">;

async function api<T>(
  method: string,
  path: string,
  body?: unknown,
  contentType = "application/json",
  signal?: AbortSignal,
): Promise<T> {
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
    ...(signal ? { signal } : {}),
  } as RequestInit).catch((e: Error) => {
    throw new CliError(`cannot reach ${unix ?? base}: ${e.message}`);
  });
  const out = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new CliError(out.error ?? `${res.status} ${res.statusText}`, res.status);
  return out;
}

function table(rows: string[][]): string {
  const widths = rows[0]?.map((_, c) => Math.max(...rows.map((r) => (r[c] ?? "").length))) ?? [];
  return rows
    .map((r) =>
      r
        .map((cell, c) => cell.padEnd(widths[c] ?? 0))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

const age = (ms: number): string => {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  return s < 60
    ? `${s}s`
    : s < 3600
      ? `${Math.floor(s / 60)}m`
      : s < 86400
        ? `${Math.floor(s / 3600)}h`
        : `${Math.floor(s / 86400)}d`;
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

/** The scheduling flags shared by submit and template run. --at is read in this machine's time zone. */
function overrides(flags: Record<string, string | true>): Overrides {
  const out: Overrides = {};
  if (typeof flags.on === "string") out.on = flags.on;
  if (flags.priority !== undefined) {
    out.priority = Number(flags.priority);
    if (!Number.isInteger(out.priority)) throw new CliError("--priority takes a whole number");
  }
  if (flags.at !== undefined && flags.after !== undefined) throw new CliError("give --at or --after, not both");
  if (typeof flags.after === "string") out.begin = `+${flags.after.replace(/^\+/, "")}`;
  if (typeof flags.at === "string") {
    const clock = flags.at.match(/^(\d{1,2}):(\d{2})$/);
    let when = new Date(flags.at);
    if (clock) {
      when = new Date();
      when.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
      if (when.getTime() <= Date.now()) when.setDate(when.getDate() + 1);
    }
    if (Number.isNaN(when.getTime())) throw new CliError(`cannot read --at ${flags.at}; use 03:00 or 2027-01-31T03:00`);
    out.begin = when.toISOString();
  }
  return out;
}

const clock = (ms: number): string => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** Why a job is waiting, for the queue listing. */
const why = (j: { reason?: string | null; pending_reason?: string | null; begin_at?: number | null }): string =>
  j.reason ??
  (j.pending_reason === "scheduled" && j.begin_at ? `not before ${clock(j.begin_at)}` : (j.pending_reason ?? ""));

function printEvent(e: ChangeEvent): void {
  const who = [e.job, e.attempt !== null ? `#${e.attempt}` : null, e.host ? `@${e.host}` : null]
    .filter(Boolean)
    .join(" ");
  const data = e.data && Object.keys(e.data as object).length ? ` ${JSON.stringify(e.data)}` : "";
  console.log(
    `${String(e.seq).padStart(6)}  ${new Date(e.ts).toISOString().slice(11, 19)}  ${e.type.padEnd(22)} ${who}${data}`,
  );
}

async function main(): Promise<void> {
  const [cmd = "help", ...rest] = process.argv.slice(2);
  const { pos, flags, sets } = parseArgs(rest);
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
    case "--version": {
      console.log(`cnoc ${runningVersion()} (protocol ${PROTOCOL})`);
      const s = await api<{ version: string; protocol: number }>("GET", "/v1/health").catch(
        () => /* server unreachable: show the client only */ null,
      );
      if (s) console.log(`server ${s.version} (protocol ${s.protocol})`);
      return;
    }

    case "server": {
      const file =
        typeof flags.config === "string"
          ? (JSON.parse(readFileSync(home(flags.config), "utf8")) as Partial<ServerOptions>)
          : {};
      const server = await new CnocServer({
        ...file,
        dataDir: home(str(flags.data, file.dataDir ?? "~/.local/share/cnoc")),
        port: Number(str(flags.port, String(file.port ?? 7878))),
        hostname: str(flags.host, file.hostname ?? "127.0.0.1"),
        openEnrollment: flags["open-enrollment"] === true || file.openEnrollment === true,
      }).start();
      console.log(`[server] cnoc ${server.version} listening on ${server.url}`);
      console.log(
        `[server] admin token: ${join(home(str(flags.data, file.dataDir ?? "~/.local/share/cnoc")), "admin.token")}`,
      );
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
          const text = readFileSync(f, "utf8");
          if (isTemplate(text)) {
            const t = checkTemplate(text);
            const args = t.args.map((a) => (a.default === null ? a.name : `${a.name}=${a.default}`)).join(", ");
            console.log(`ok    ${f}  (template ${t.name}; arguments: ${args})`);
            continue;
          }
          const spec = parseJob(text);
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
      const r = await api<Submitted>("POST", "/v1/jobs", {
        jobs: pos.map((f) => readFileSync(f, "utf8")),
        overrides: overrides(flags),
      });
      for (const j of r.jobs) console.log(`${j.created ? "submitted" : "unchanged"}  ${j.id}  ${j.state}`);
      return;
    }

    case "template":
    case "t": {
      const sub = pos[0] ?? "list";
      const ref = () => {
        const v = need(1, "REF (a template's number, name or file)");
        // A file path is also sent resolved, so `rm` finds the template from any directory.
        return `ref=${encodeURIComponent(v)}${/^\d+$/.test(v) ? "" : `&path=${encodeURIComponent(resolve(v))}`}`;
      };
      const args = (t: { args: Array<{ name: string; default: string | null }> }) =>
        t.args.map((a) => (a.default === null ? a.name : `${a.name}=${a.default}`)).join(" ") || "-";
      switch (sub) {
        case "add": {
          need(1, "FILE");
          for (const f of pos.slice(1)) {
            const r = await api<{ template: TemplateInfo; result: string }>("POST", "/v1/templates", {
              text: readFileSync(f, "utf8"),
              source: resolve(f),
            });
            console.log(`${r.template.id}  ${r.template.name}  ${r.result}`);
          }
          return;
        }
        case "list":
        case "ls": {
          const r = await api<{ templates: TemplateInfo[] }>("GET", "/v1/templates");
          if (asJson) return console.log(JSON.stringify(r, null, 2));
          if (r.templates.length === 0) return console.log("no templates; add one with: cnoc template add FILE");
          const rows = [["ID", "NAME", "ARGUMENTS", "RUNS", "LAST RUN", "FROM"]];
          for (const t of r.templates)
            rows.push([
              String(t.id),
              t.name,
              args(t),
              String(t.runs),
              t.last_run_at ? `${age(t.last_run_at)} ago` : "-",
              t.source ?? "-",
            ]);
          return console.log(table(rows));
        }
        case "show": {
          const r = await api<{ template: TemplateRow }>("GET", `/v1/template?${ref()}`);
          if (asJson) return console.log(JSON.stringify(r, null, 2));
          console.log(
            `# template ${r.template.id}: ${r.template.name}   arguments: ${args(r.template)}   runs: ${r.template.runs}`,
          );
          return console.log(r.template.body.trimEnd());
        }
        case "run": {
          const set: Record<string, string> = {};
          for (const kv of sets) {
            const i = kv.indexOf("=");
            if (i < 1) throw new CliError(`--set takes NAME=VALUE, got ${kv}`);
            set[kv.slice(0, i)] = kv.slice(i + 1);
          }
          if (flags.key === true) throw new CliError("--key takes a value");
          const key = typeof flags.key === "string" ? flags.key : undefined;
          const r = await api<OneJob & { created: boolean }>("POST", `/v1/template/run?${ref()}`, {
            set,
            overrides: overrides(flags),
            ...(key !== undefined ? { key } : {}),
          });
          if (!r.created) return console.log(`exists     ${r.job.id}  ${r.job.state}  (already run with this key)`);
          return console.log(`submitted  ${r.job.id}  ${r.job.state}${why(r.job) ? `  (${why(r.job)})` : ""}`);
        }
        case "rm":
        case "remove": {
          const r = await api<{ template: TemplateInfo }>("DELETE", `/v1/template?${ref()}`);
          return console.log(`removed  ${r.template.id}  ${r.template.name}`);
        }
        default:
          throw new CliError(`unknown template command: ${sub} (add, list, show, run, rm)`);
      }
    }

    case "priority": {
      const r = await api<OneJob>(
        "POST",
        `/v1/job/priority?id=${encodeURIComponent(need(0, "ID"))}&value=${encodeURIComponent(need(1, "N"))}`,
      );
      return console.log(`${r.job.id}  priority ${r.job.priority}  ${r.job.state}`);
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
          const r = await api<Submitted>("POST", "/v1/jobs", { jobs: bodies });
          for (const j of r.jobs) if (j.created) console.log(`[ingest] submitted ${j.id} (${j.state})`);
        } catch (batchError) {
          // One bad file must not hold back the rest: fall back to one at a time.
          console.error(`[ingest] batch refused: ${(batchError as Error).message}`);
          for (const [i, body] of bodies.entries()) {
            try {
              const r = await api<Submitted>("POST", "/v1/jobs", { jobs: [body] });
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

    case "feed":
      return process.exit(
        await feedCommand(rest, {
          health: (signal) => api<unknown>("GET", "/v1/health", undefined, undefined, signal),
          run: (ref, body, signal) =>
            api<unknown>("POST", `/v1/template/run?ref=${encodeURIComponent(ref)}`, body, undefined, signal),
        }),
      );

    case "queue": {
      const r = await api<{ jobs: JobInfo[] }>("GET", `/v1/jobs${flags.all ? "?all=1" : ""}`);
      if (asJson) return console.log(JSON.stringify(r, null, 2));
      if (r.jobs.length === 0) return console.log("nothing queued or running");
      const rows = [["JOB", "STATE", "HOST", "PRIO", "AGE", "WHY"]];
      for (const j of r.jobs)
        rows.push([j.id, j.state, j.host ?? "-", String(j.priority), age(j.submitted_at), why(j)]);
      return console.log(table(rows));
    }

    case "show": {
      const r = await api<{ job: JobInfo; attempts: AttemptRow[] }>(
        "GET",
        `/v1/job?id=${encodeURIComponent(need(0, "ID"))}`,
      );
      if (asJson) return console.log(JSON.stringify(r, null, 2));
      const j = r.job;
      console.log(
        `${j.id}  ${j.state}${j.reason ? `  (${j.reason})` : ""}${j.pending_reason ? `  waiting: ${j.pending_reason}` : ""}`,
      );
      console.log(
        `project ${j.project}  priority ${j.priority}  resources ${JSON.stringify(j.resources)}  depends ${JSON.stringify(j.depends)}`,
      );
      if (j.requires?.length) console.log(`requires ${j.requires.join(", ")}`);
      if (j.begin_at) console.log(`not before ${new Date(j.begin_at).toLocaleString()}`);
      for (const a of r.attempts)
        console.log(
          `  attempt ${a.id} on ${a.host}: ${a.state}${a.outcome ? ` ${a.outcome}` : ""}${a.reason ? ` (${a.reason})` : ""}`,
        );
      for (const [i, s] of (j.result ?? []).entries()) {
        const how = s.reported === false ? "no report" : `${s.status}${s.handoff ? `  handoff ${s.handoff}` : ""}`;
        console.log(`  stage ${i + 1}: ${how}  ${s.summary}`);
        if (s.usage) console.log(`    tokens: ${formatUsage(s.usage)}`);
      }
      return;
    }

    case "cancel":
    case "requeue":
    case "abandon": {
      const r = await api<OneJob>("POST", `/v1/job/${cmd}?id=${encodeURIComponent(need(0, "ID"))}`);
      return console.log(`${r.job.id}  ${r.job.state}${r.job.cancel_requested ? "  (cancel requested)" : ""}`);
    }

    case "hosts": {
      if (pos[0] === "approve")
        return console.log(
          `approved ${(await api<{ host: { name: string } }>("POST", `/v1/host/approve?name=${encodeURIComponent(need(1, "NAME"))}`)).host.name}`,
        );
      const r = await api<{ version?: string; hosts: HostInfo[] }>("GET", "/v1/hosts");
      if (asJson) return console.log(JSON.stringify(r, null, 2));
      console.log(`server ${shortVersion(r.version)}`);
      if (r.hosts.length === 0) return console.log("no hosts have connected");
      const rows = [["HOST", "STATUS", "VERSION", "RUNNING", "RESERVED / CAPACITY", "LOAD", "KEY"]];
      const behind: string[] = [];
      for (const h of r.hosts) {
        const m = h.online ? null : h.mismatch;
        if (m)
          behind.push(
            `${h.name} runs ${shortVersion(m.version)}, ${age(m.at)} ago: ${printable(m.note ?? "no update reported")}`,
          );
        const status =
          h.status === "pending" ? "pending" : m ? "outdated" : h.drained ? "drained" : h.online ? "online" : "offline";
        const res = Object.keys(h.capacity)
          .map((n: string) => `${n} ${h.reserved[n] ?? 0}/${h.capacity[n]}`)
          .join(", ");
        const load = h.measured ? (h.measured.load1 / Math.max(1, h.measured.cpus)).toFixed(2) : "-";
        const version = shortVersion(m?.version ?? h.version);
        rows.push([h.name, status, version, String(h.running.length), res || "-", load, h.fingerprint]);
      }
      console.log(table(rows));
      if (behind.length > 0) console.log(`\n${behind.join("\n")}`);
      return;
    }
    case "drain":
    case "undrain": {
      const r = await api<{ host: { name: string; drained: boolean } }>(
        "POST",
        `/v1/host/drain?name=${encodeURIComponent(need(0, "NAME"))}&on=${cmd === "drain" ? 1 : 0}`,
      );
      return console.log(`${r.host.name}  ${r.host.drained ? "drained" : "accepting work"}`);
    }

    case "attach": {
      const session = `cnoc-${need(0, "ATTEMPT")}-${Number(pos[1] ?? 1) - 1}`;
      const p = Bun.spawn(["tmux", "-L", process.env.CNOC_TMUX_SOCKET ?? "cnoc", "attach", "-r", "-t", `=${session}`], {
        stdio: ["inherit", "inherit", "inherit"],
      });
      process.exit(await p.exited);
      return;
    }

    case "events": {
      let after = Number(str(flags.after, "0"));
      for (;;) {
        const r = await api<{ events: ChangeEvent[]; next: number }>(
          "GET",
          `/v1/events?after=${after}&wait=${flags.follow ? 30 : 0}`,
        );
        for (const e of r.events as ChangeEvent[]) asJson ? console.log(JSON.stringify(e)) : printEvent(e);
        after = r.next;
        if (!flags.follow && r.events.length === 0) return;
      }
    }

    case "progress": {
      await progress(pos.join(" "));
      return;
    }
    // Each exits once its report is answered: a transcript read given up at its time limit may leave a file open.
    case "done":
      await report({ status: "done", summary: pos.join(" ") });
      return process.exit(0);
    case "fail":
      await report({ status: "failed", summary: pos.join(" ") });
      return process.exit(0);
    case "handoff":
      await report(parseHandoff(rest));
      return process.exit(0);
    case "usage":
      await snapshot(rest.includes("--print"));
      return process.exit(0);

    default:
      throw new CliError(`unknown command: ${cmd}\n\n${HELP}`);
  }
}

main().catch((e) => {
  if (e instanceof CliError || e instanceof ReportError) console.error(`cnoc: ${e.message}`);
  else console.error(e);
  process.exit(1);
});
