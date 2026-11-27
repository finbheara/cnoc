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
- The template's `id` is its name and may not contain an argument. Each run is submitted as the job `<name>/<n>`. The counter belongs to the name and survives removal of the template, so job ids are never reused.
- A run is an ordinary job: its text is the filled-in template and does not change if the template does. It carries the label `template: <name>`.
- Adding a template whose name exists replaces its text and keeps its number. A template is found by number, by name, or by the path of the file it was added from.
- A template is validated when added, with `1` standing in for arguments that have no default.

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
cnoc progress "note"      # a changelog event; best effort
cnoc done "summary"       # the stage succeeded
cnoc fail "reason"        # the stage failed
```

- The first `done` or `fail` for a stage wins; later ones are ignored.
- A stage that ends with no report is `failed` with reason `no-result`.
- A project may call these from a stop hook so a result is reported even when the agent forgets.
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
| client → server | `hello` | Host name, public key, signature over the nonce, its version. On another version, an `update` note saying what it is doing about it. |
| server → client | `pending` | The key is not approved yet. The connection closes. |
| server → client | `welcome` | Accepted. Carries a short-lived API token and the heartbeat interval. |
| client → server | `sync` | The full view: capacity, features, running attempts, finished-but-unacknowledged attempts. |
| client → server | `status` | Heartbeat: measured load, reserved counts, running attempts. |
| server → client | `assign` | An attempt and its job. |
| client → server | `decline` | The host will not run it, with a reason. |
| client → server | `started` | The first session exists. |
| client → server | `progress` | A note from the harness. |
| client → server | `ended` | Outcome, reason and per-stage results. |
| server → client | `ack` | The `ended` was recorded. |
| server → client | `cancel` | Stop this attempt. |

### 8.1 Versions and updates

- **The version is the code.** A process running from a git checkout reports the commit it was started from, resolved once at start (`src/version.ts`). Tracked files that differ from it add `-dirty`; untracked files do not count. Without a checkout, or when git fails, it reports the constant `VERSION` in `src/protocol.ts`. `CNOC_VERSION` overrides all of this. The git calls are read-only, name the directory safe for that call (so a service user can read another user's clone), and have a time limit. The session-side commands (`cnoc done` and the like) never resolve it.
- A server or client whose version is the fallback or ends in `-dirty` logs a `WARNING` line at start saying why, because either strands every other host.
- The `challenge` states the server's version. A client on a different version still sends a signed `hello` carrying its version and an `update` note; the server enrolls an unknown key as usual and closes. No work is sent. For an approved key only, it records the version (if it is a commit or a plain version string, else `(invalid)`) and the note with control characters removed and its length bounded, for `cnoc hosts`; the CLI strips control characters again. The record goes when the host connects on the right version, when its key is not approved, or when the server restarts.
- The client then brings its own checkout to exactly that commit: `git fetch origin`, and if that does not bring it, `git fetch origin COMMIT`; `git checkout --detach COMMIT`; `bun install --frozen-lockfile`. It exits with status 75 so its service manager starts the new code. If a step after the checkout fails, it checks the previous commit (or branch) out again and reinstalls its dependencies, so a host is never left on new code with old dependencies. It refuses a version that is not a full commit name (a `-dirty` server, a non-checkout fallback) a commit name of the other hash kind, and a clone with uncommitted changes (the log line says how to discard them, for a checkout an interrupted update left behind).
- The config's `update` field, if set, replaces that procedure with a shell command run with `CNOC_TARGET_VERSION` set. If the client runs from a git checkout, the result is checked: a command that succeeds but leaves the checkout short of the target counts as a failure. The command an older installer wrote there, or the example config showed (`git pull` of a branch), is recognised by one pattern, `LEGACY_UPDATE`, that the client and `install.sh` share; the client ignores it and the installer removes it.
- **Backoff.** Each try for one target is recorded in the state directory (`update.json`), so it survives the exit. After a try that failed, or did not end in a restart, the next waits 1 minute, doubling to at most 30. A client exits only when that can help: its checkout moved, or the code was already in place and it has not yet restarted for this target. Meanwhile it asks the server at most every 5 minutes whether the version changed; a new target is tried at once. However many targets there are, at most 5 tries in an hour end in a restart, so a server whose version flaps cannot make a host thrash. The wait is capped at 30 minutes even if the clock jumps back. If the disk refuses the record, it is kept in memory and the failure logged once. Agreement clears the record, except the restart history.
- Running sessions are unaffected and are re-adopted on restart.
- **Trust.** The server chooses which commit of the client clone's own `origin` the client runs, and nothing more: the commit is validated as a hex object name and passed to git as an argument, never through a shell, and the remote is the one the clone already has. A compromised server can roll a host to any commit of that repository, old ones included.

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
| `GET /v1/job?id=` | One job with its text and attempts. |
| `POST /v1/job/cancel?id=` | Cancel. Immediate before start; a request to the host after. |
| `POST /v1/job/requeue?id=` | Run a failed or cancelled job again. |
| `POST /v1/job/abandon?id=` | Admin. Give up on a running job whose host is offline. |
| `POST /v1/job/priority?id=&value=` | Change the priority of a job that has not been dispatched. |
| `GET /v1/templates` | Templates, without their text. |
| `POST /v1/templates` | Admin. Add or replace: `{ "text", "source"? }`. |
| `GET /v1/template?ref=` | One template with its text. `ref` is a number, a name or a source path. |
| `DELETE /v1/template?ref=` | Admin. Remove. Jobs it started are unaffected. |
| `POST /v1/template/run?ref=` | Start a job: `{ "set"?: { NAME: value }, "overrides"? }`. |
| `GET /v1/hosts` | The server's `version`, and hosts with capacity, reserved counts, load, running attempts, the version each last connected with, and `mismatch` (version, note, time) for a host last refused for its version. |
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
| `template.run` | A template started a job; the event names the job and the arguments. |
| `job.terminal` | The job is `done`, `failed` or `cancelled`. |
| `attempt.assigned`, `.returned`, `.started`, `.progress`, `.ended` | The life of one attempt. |
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
