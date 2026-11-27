# Cnoc specification, draft 2

This replaces the first requirements draft (working name "Swarm"). It describes the design as built in this repository, and marks what is specified but not built. [PLAN.md](PLAN.md) tracks the gap.

## 1. Scope

Cnoc runs agent harness sessions as batch jobs across a small fleet of persistent hosts.

**In scope**

- Jobs with dependency edges between job ids.
- A realtime view of what is queued and what is running.
- Generic counted resources per host and per fleet, so the right jobs land on the right hosts.
- A numbered changelog of every state change, readable by polling, stream or webhook.
- Starting any harness that runs in a terminal, through an adapter file.

**Out of scope**

- A backlog, or any assumption about GitHub or an issue tracker. A job is self-contained.
- Planning. Each project plans its own work. A planning run is just another job, and a planner can subscribe to the changelog.
- A definition of done, review, CI or merge policy. The agent reports its own result.
- Pre-emption. A job that has started is never evicted by the scheduler.
- Running while offline. If the server cannot be reached, nothing new starts.

**Why persistent hosts.** The projects this is for carry tens of gigabytes of local data, and their harnesses are logged in with a subscription on a particular machine. Neither survives an ephemeral environment. The unit of placement is "this harness, on a box that has this checkout".

## 2. Parts

| Part | Role |
|---|---|
| **server** | One process holding the queue, the resource ledger, the placement policy and the changelog in one SQLite file. |
| **client** | One per host. Dials out to the server, reports what the host offers, runs what it is handed. |
| **harness** | The agent CLI, running in a tmux session the client created. |
| **adapter** | A file that says how to start, wait for and stop one kind of harness. |
| **Jobfile** | The text of a job: front matter for the scheduler, instructions for the client. |

```
 harness  ◄── spawns ───  client  ─── connects (WebSocket) ──►  server  ◄── pulls ──  job repo
 harness  ─── reports ──► client  ◄── jobs, cancels ─────────   server
                          client  ─── status, results ──────►   server
```

- There is one server. If it is down, nothing new starts. This is accepted.
- A client only ever dials out. Hosts need no inbound ports.
- A session belongs to tmux, not to the client process, so it outlives a client restart or upgrade.

## 3. Jobfile

A Jobfile is YAML front matter followed by one instruction per line, in the Dockerfile tradition. The grammar is deliberately small so a repository check can validate it and restrict it.

### 3.1 Front matter

| Key | Required | Meaning |
|---|---|---|
| `id` | yes | Chosen by the submitter. Unique for the life of the server. Matches `[A-Za-z0-9._-]+(/[A-Za-z0-9._#-]+)*`. |
| `priority` | no | Integer, higher is dispatched first. Default 0. It orders the queue and never interrupts a running job. |
| `resources` | no | Map of name to count. Default `{ slots: 1 }`. |
| `requires` | no | Host features needed beyond the implied ones. `host/<name>` names one host. |
| `depends` | no | Job ids that must be `done` first. |
| `time` | no | Wall-clock limit for the whole job (`90s`, `30m`, `4h`, `1d2h`). |
| `begin` | no | The job may not start before this. A time with a zone (`2027-01-31T03:00:00Z`), or `+duration` counted from submission. A time without a zone is an error. |
| `labels` | no | Free-form map. Ignored by Cnoc. |
| `key` | no | Templates only (3.5): names each run `<id>/<key>`, so a run with the same key is started once. An error in a plain Jobfile. |

An unknown key is an error.

### 3.2 Instructions

| Instruction | Meaning |
|---|---|
| `FROM project` | Required, once. The host resolves the name to a local checkout. |
| `HARNESS name [args]` | Sets the harness for the prompts that follow. |
| `PROMPT text` | One session, called a stage. Quoted string, bare text, or a heredoc. |
| `ENV NAME=value` | Environment for every stage. |

- Stages run in order. A stage that reports `failed`, or ends without reporting, ends the job.
- `#` starts a comment line. A trailing `\` continues a line.
- `RUN`, `WORKTREE` and `WORKDIR` are reserved and rejected.

A job implies the features `project/<FROM>` and `harness/<name>` for each stage. A host is eligible only if it reports all of them. The server adds `host/<name>` to every host's features itself and drops any `host/` feature a client reports, so a host cannot answer for another.

### 3.3 Identity and immutability

- The submitter picks the id, so a dependency can name a job before it is submitted.
- Submitting an id that exists with the same text is a no-op. Submitting it with different text is refused.
- A batch is atomic. Jobs in one batch may depend on each other; unknown dependencies and cycles reject the whole batch.

### 3.4 Overrides

A submitter may set three scheduling fields without editing the Jobfile: `on` (a host name, added as `host/<name>` to `requires`), `priority` and `begin`. They apply to every job in the call, are recorded in the `job.submitted` event, and are ignored for a job that already exists. An unknown host is refused.

A job's priority can be changed while it is `blocked` or `queued`. Once a host has been given the job it cannot.

### 3.5 Templates

A template is a Jobfile stored on the server so it can be started repeatedly.

- `ARG NAME` or `ARG NAME=default` declares an argument; names are capitals, digits and underscores. `ARG` is an error in a plain job.
- Starting a template replaces `${NAME}` for every declared argument throughout the text, front matter included, and removes the `ARG` lines. Undeclared names are left alone. An argument with no default must be supplied; an unknown argument is an error.
- The template's `id` is its name and may not contain an argument. Each run is submitted as the job `<name>/<n>`. The counter belongs to the name and survives removal of the template, so job ids are never reused, and it skips any id that already exists.
- A run may have a key. It comes from the run request, or else from the template's `key:` front matter line, which is filled from the arguments like the rest of the text (`key: ${PROJECT}-${ISSUE}`). A keyed run is the job `<name>/<key>`. The key may contain `/` and must match `[A-Za-z0-9._#-]+(/[A-Za-z0-9._#-]+)*`, and the whole id must be a valid id. A segment may not be `.` or `..`, and the key may not be all digits: those ids are the numbered runs, so a keyed run and a numbered one never share an id. The line is read as the template writes it, before arguments are filled in: a bare value is taken literally, not as a YAML number (`0x7` stays `0x7`), up to a ` #` comment as YAML would; a quoted value is read as a YAML string. A `#` or a quote in an argument's value is part of the key, and is refused as not a valid id segment. A key given with the run replaces the declared one entirely; the declared one is not read. `key` is an error in a plain Jobfile, and the `key:` line is removed from the job a run creates.
- A keyed run whose job already exists is a no-op, in any state of that job and whatever the arguments or the template now say: no job, no event, no count. To make that hold for a declared key, only the `key:` line is filled (from the arguments given and the defaults) to find the job; the rest of the template is filled only for a new run. A failed or cancelled run is run again with requeue. This makes a run safe to offer repeatedly, like a submission (3.3).
- A job by that id that the template did not start (a plain submission, or a run of another template whose name makes the same id) is not taken for the run: the request is refused with 409.
- A run is an ordinary job: its text is the filled-in template and does not change if the template does. It carries the label `template: <name>`.
- Adding a template whose name exists replaces its text and keeps its number. A template is found by number, by name, or by the path of the file it was added from.
- A template is validated when added, with `1` standing in for arguments that have no default. That includes its key.

## 4. Adapters

An adapter is a file named `<harness>.harness` in the same syntax.

| Instruction | Meaning |
|---|---|
| `REQUIRE bin...` | The host offers the harness only if each binary is on its `PATH`. |
| `TMUX command` | Required, first. Starts the session in the project directory. |
| `EXPECT "regex" [TIMEOUT n]` | Waits for the visible screen to match. Default 60 seconds. |
| `TYPE "text" Key...` | Sends text and named keys. Multi-line or long text is pasted. |
| `SLEEP n` | Waits `n` seconds. |
| `STOP TYPE…` / `STOP SLEEP…` | Steps run when the session is asked to end. |

Variables: `${PROMPT}`, `${REPORT}` (the reporting instructions), `${TASK}` (both), `${ARGS}`, `${JOB}`, `${ATTEMPT}`, `${STAGE}`. Inside `TMUX`, the three free-text variables are shell-quoted. Any other `${NAME}` is left for the shell.

A stage ends when the harness reports a result, the process exits, the job's time limit passes, or a cancel arrives. The client then runs the `STOP` steps, waits up to five seconds for the process to exit, saves the scrollback to a log file and removes the session.

A failed `EXPECT` fails the job with a reason that quotes the last lines of the screen. That is how a login prompt or a "trust this folder" prompt becomes a readable failure, not a silent hang.

Sessions run under `/bin/sh` on a dedicated tmux socket named `cnoc`, with the client's environment plus the job's `ENV`.

## 5. Result contract

Each session has on its `PATH`:

```
cnoc progress "note"                # a changelog event; best effort
cnoc done "summary"                 # the stage succeeded
cnoc fail "reason"                  # the stage failed
cnoc handoff MERGED [-m "note"]     # succeeded, and says how the work was left
cnoc handoff BLOCKED -m "reason"    # failed, the same way; the message is required
cnoc usage                          # record token usage so far; does not end the stage
```

- The first `done`, `fail` or `handoff` for a stage wins; later ones are ignored.
- A stage that ends with no report is `failed` with reason `no-result`.
- A project may call these from a stop hook so a result is reported even when the agent forgets.
- The instructions appended to a prompt (`${REPORT}`) tell the agent to use the closing command its prompt names, and `done` or `fail` only if it names none.

**Handoff.** The status is read in any case and stored upper case in the stage result's `handoff` field. The set is fixed in the code (`MERGED` → `done`, `BLOCKED` → `failed`); anything else is refused with the list. It is not the `blocked` job state.

**Usage.** `done`, `fail` and `handoff` attach the calling session's token usage to the result when they can read it. A collector per harness finds the session; only Claude Code has one. It takes the session id from `CLAUDE_CODE_SESSION_ID`, reads `<config>/projects/*/<id>.jsonl` (config is `$CLAUDE_CONFIG_DIR` or `~/.claude`) and every `*.jsonl` under `<id>/subagents/`, as a stream with a time limit. Claude Code writes a line per content block and repeats the response's usage on each under one `message.id`, with a smaller `output_tokens` on early blocks and not always in order; each id is counted once, at the largest value of each count, across all of the session's files. Lines that are not `assistant` entries with usage, and entries whose counts are all zero, are ignored.

```
usage: { harness, session, responses, at,
         tokens:   { input, output, cache_creation, cache_read },
         by_model: { <model>: { input, output, cache_creation, cache_read } },
         partial?: "why the numbers are a lower bound" }
```

- No session, no transcript or an unreadable file means no `usage`; the result is never refused for it. A time limit or an unparseable line that carried usage gives `partial`.
- `cnoc usage` is for a Claude Code `Stop` hook: it takes `session_id` and `transcript_path` from the hook's JSON on stdin when present, is silent and always exits 0. The client keeps the latest snapshot per stage. A report without usage takes it; a stage that ends with no report (no result, time limit, cancel) gets a result `{ status: "failed", summary: <reason>, reported: false, usage }` so the numbers are not lost.
- A session does not inherit a harness session variable from the client's own environment; a job's `ENV` may set one.
- The commands talk to the client over a local socket using a per-attempt token. A job holds no server credential.
- The same socket forwards server API calls, so a job can submit follow-up jobs. They are recorded as submitted by the host.

## 6. States

```
blocked ──► queued ──► assigned ──► running ──► done | failed | cancelled
   ▲                       │
   └── requeue             └── given back (host declined or went away before starting) ──► queued
```

| State | Meaning |
|---|---|
| `blocked` | A dependency is not `done`. If one has failed or been cancelled, the reason names it. |
| `queued` | Ready. `pending_reason` says why it is not placed: `resources`, `no-eligible-host`, `held-back`, or `scheduled` when its `begin` time has not come. |
| `assigned` | Handed to a host that has not yet started it. |
| `running` | The host has started the first session. |
| `done`, `failed`, `cancelled` | Terminal. `failed` carries a reason. |

- Blocked is a scheduling rule only. A job cannot become blocked after it starts.
- `failed` or `cancelled` jobs can be requeued. That opens a new attempt on the same id and re-evaluates dependents when it finishes.
- A time limit ends a job as `failed` with reason `timeout`.

## 7. Resources and placement

- A **resource** is a name and a count. A host declares its capacity in its client config. The server keeps the ledger of what open attempts hold.
- A host that does not declare a name has zero of it.
- A **pool** is a fleet-wide counter in the server config. A job resource with a pool's name draws from the pool, not from the host.
- Every status message carries the host's reserved counts and measured load (CPU count, one-minute load, memory).
- A client declines an assignment it cannot honour: missing project, missing adapter, counts exceeded, or load above its configured ceiling. The server keeps that job off that host for a backoff period.

Placement is three pluggable functions, after the Kubernetes scheduler:

1. `order(queue)` — default: priority, then age.
2. `filter(job, host)` — default: skip a host that recently declined the job.
3. `score(job, host)` — default: most free capacity, least load.

**Begin times.** A job whose `begin` is in the future is not offered to the policy at all. From its begin time on, it is aged from that time, not from submission.

**Starvation.** A job that has waited longer than `starveAfterS` for resources holds back later jobs that want the same resource names on hosts that could run it. A job no host could ever fit holds nothing back.

## 8. Client and server protocol

One WebSocket per host, JSON messages, opened by the client at `/v1/client`.

| Direction | Message | Meaning |
|---|---|---|
| server → client | `challenge` | A nonce, the server's version and protocol number. |
| client → server | `hello` | Host name, public key, signature over the nonce. |
| server → client | `pending` | The key is not approved yet. The connection closes. |
| server → client | `welcome` | Accepted. Carries a short-lived API token and the heartbeat interval. |
| client → server | `sync` | The full view: capacity, features, running attempts, finished-but-unacknowledged attempts. |
| client → server | `status` | Heartbeat: measured load, reserved counts, running attempts. |
| server → client | `assign` | An attempt and its job. |
| client → server | `decline` | The host will not run it, with a reason. |
| client → server | `started` | The first session exists. |
| client → server | `progress` | A note from the harness. |
| client → server | `ended` | Outcome, reason and per-stage results, each with its optional `handoff` and `usage` (§5). |
| server → client | `ack` | The `ended` was recorded. |
| server → client | `cancel` | Stop this attempt. |

### 8.1 Versions and updates

- The `challenge` states the server's version. A client on a different version sends nothing further.
- It runs its configured `update` command with `CNOC_TARGET_VERSION` set, then exits with status 75 so its service manager starts the new code.
- Running sessions are unaffected and are re-adopted on restart.

### 8.2 Reconciliation

State is reconciled, not assumed. Both sides can restart at any time.

**When a host connects and sends `sync`:**

| Server believes | Host says | Result |
|---|---|---|
| attempt is assigned or running | running | Kept, marked running. |
| attempt is assigned | not mentioned | Given back; the job is queued again. |
| attempt is running | not mentioned | Failed with reason `lost-by-host`. |
| attempt was given back, job still queued | running | Adopted: the job is running on that host after all. |
| attempt ended, was abandoned, or the job moved on | running | The host is told to cancel it. |
| anything | finished, awaiting ack | The `ended` message follows and is recorded if the attempt is still open. |

**When a host disconnects:** attempts it never started go back to the queue. Attempts it started stay with it, for as long as it takes.

**When the server restarts:** every assigned-but-not-started attempt is given back.

**When a client restarts:** it reads its saved attempts. A session that still exists is watched again. A session that is gone ends the attempt as `failed`. An attempt caught mid-launch is failed.

**A finished attempt** stays in the client's outbox on disk until the server acknowledges it.

**The server never declares running work lost because of time.** A host that is unreachable keeps its jobs. A person can `abandon` a job on an offline host, accepting that the session may still be alive; if the host returns, it is told to stop.

### 8.3 Identity

- A client generates an Ed25519 key on first start. Its fingerprint is shown in `cnoc hosts`.
- An unknown key is recorded as `pending` until an admin approves it, unless the server runs with open enrollment.
- A host name is bound to the first key that claimed it.
- One state directory serves one client process. A second connection under the same identity replaces the first, and the replaced client backs off.

## 9. HTTP API

Bearer token on every call except health. The admin token may do everything. A host's API token may submit, read, cancel and requeue.

| Call | Purpose |
|---|---|
| `POST /v1/jobs` | Submit. Body is one Jobfile as text, or `{ "jobs": [text...], "overrides"?: { on, priority, begin } }` as an atomic batch. |
| `GET /v1/jobs` | Non-terminal jobs. `?all=1`, `?state=a,b`, `?project=`. |
| `GET /v1/job?id=` | One job with its text and attempts. Each stage in `result` may carry `handoff` and `usage` (§5). |
| `POST /v1/job/cancel?id=` | Cancel. Immediate before start; a request to the host after. |
| `POST /v1/job/requeue?id=` | Run a failed or cancelled job again. |
| `POST /v1/job/abandon?id=` | Admin. Give up on a running job whose host is offline. |
| `POST /v1/job/priority?id=&value=` | Change the priority of a job that has not been dispatched. |
| `GET /v1/templates` | Templates, without their text. |
| `POST /v1/templates` | Admin. Add or replace: `{ "text", "source"? }`. |
| `GET /v1/template?ref=` | One template with its text. `ref` is a number, a name or a source path. |
| `DELETE /v1/template?ref=` | Admin. Remove. Jobs it started are unaffected. |
| `POST /v1/template/run?ref=` | Start a job: `{ "set"?: { NAME: value }, "overrides"?, "key"?: string, "keyed"?: boolean }`. A `key` of null is the same as none. `keyed: true` refuses (400) a run that has no key from the request or the template; a key whose id belongs to a job the template did not start is refused with 409. Answers `{ job, template, created, state, seq }`; `created` is false when a keyed run's job already existed, and `state` is the job's state. |
| `GET /v1/hosts` | Hosts with capacity, reserved counts, load and running attempts. |
| `POST /v1/host/approve?name=` | Admin. Approve a pending key. |
| `POST /v1/host/drain?name=&on=1\|0` | Admin. Stop or resume placing work on a host. |
| `GET /v1/state` | Snapshot of jobs, hosts and pools, with `as_of`. |
| `GET /v1/events?after=&limit=&wait=` | A page of the changelog; `wait` long-polls up to 60 seconds. |
| `GET /v1/events/stream?after=` | Server-sent events. `Last-Event-ID` also resumes. |
| `POST`, `GET`, `DELETE /v1/subscriptions` | Admin. Webhooks. |
| `GET /v1/health` | Version and protocol, no token. |

Every mutation returns the changelog sequence it reached. Every read returns `as_of`.

## 10. Changelog

Each event is `{ seq, ts, type, job, attempt, host, actor, data }`. `seq` increases by one and never repeats.

| Type | When |
|---|---|
| `job.submitted` | A new job is stored. |
| `job.ready` | Its last dependency finished; it is queued. |
| `job.unstartable` | A dependency failed or was cancelled. |
| `job.cancel_requested` | Cancel was asked of a job already on a host. |
| `job.requeued` | A terminal job was sent round again. |
| `job.priority` | A waiting job's priority was changed. |
| `template.added`, `.updated`, `.removed` | A template changed. |
| `template.run` | A template started a job; the event names the job, the arguments and the key, if any. A keyed run that changed nothing has no event. |
| `job.terminal` | The job is `done`, `failed` or `cancelled`. Data: `state`, `reason`, and `handoff` when the last stage was handed off. |
| `attempt.assigned`, `.returned`, `.started`, `.progress`, `.ended` | The life of one attempt. `.ended` data: `outcome`, `reason`, `handoff` as above, and `usage`, one entry per stage result (null where none), when any stage has usage. |
| `attempt.late_report` | A result arrived for an attempt that was no longer open. It is not applied. |
| `host.pending`, `.approved`, `.online`, `.offline`, `.drained`, `.undrained` | Host lifecycle. |

Webhooks are delivered in order and at least once. Each carries `X-Cnoc-Seq` and `X-Cnoc-Signature: sha256=<HMAC of the body with the subscription's secret>`. A failed delivery stops that subscription's queue until it succeeds.

## 11. Jobs from git

`cnoc ingest DIR` pulls a checkout and submits every `*.job` under `DIR/jobs` as one batch, repeating on an interval if asked. Idempotent submission makes this safe to repeat. The server itself knows nothing about git.

Specified but not built:

- The server merges pull requests that add job files once their checks pass.
- The server pushes job status back to the repository, eventually consistent.
- A cancel can be requested by a pull request that edits a job's front matter.

## 12. Security

- Whoever can submit a job can run a prompt on a host with that host's credentials. Guard the admin token, and guard the main branch of any ingested repository equally.
- The server speaks plain HTTP. Run it behind TLS or on a private network.
- The local socket is readable only by the client's user. A job's token is valid for that attempt only.
- `ENV` is stored in the job text. Do not put secrets in it.

## 13. Decisions and why

| Decision | Reason |
|---|---|
| One server, no failover | Leader election between hosts needs consensus or an outside arbiter. Neither is worth it at this size; an outage only pauses new work. |
| Coordination state is not in git | Leases and heartbeats would mean hundreds of commits an hour. Git is a way in for jobs, not the store. |
| No path locks | Overlap is avoided at planning time with dependency edges. A fleet pool of one covers the rare mutex. |
| tmux, not a headless mode | Sessions outlive the client, and a person can attach and see what went wrong. Headless is an adapter detail. |
| No time-based "lost" | Agent work is not safe to run twice. A person decides when to give up on a host. |
| Submitter-chosen ids | Dependencies and git files need to name a job before the server has seen it. |
| Separate from mcp-cli | That daemon is a per-user developer tool with a different lifecycle and far more credentials. It can be a harness adapter, and later a second client of this protocol. |
