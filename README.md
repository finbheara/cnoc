# Cnoc

Cnoc (say "kuh-NUCK") is Slurm's idea, sized for a handful of machines: queue agent harness sessions as batch jobs and run each one on a host that has the project, the harness and the free resources for it.

It is for work that cannot run in a throwaway environment: projects with tens of gigabytes of local data, and harnesses logged in with a subscription on a particular box. A job means "launch this harness, on a host that has this checkout, with this prompt".

Cnoc does not plan work, review it or decide when it is done. A job is a prompt; the agent reports its own result.

**Status:** early. The core loop is built and tested end to end, including a real Claude Code session. See [docs/PLAN.md](docs/PLAN.md) for what is and is not built, and [docs/SPEC.md](docs/SPEC.md) for the design.

## Install a client

On each host that will run jobs. Needs [Bun](https://bun.sh), tmux and git.

```
curl -fsSL https://raw.githubusercontent.com/finbheara/cnoc/main/install.sh | bash -s -- \
  --server http://controller.example:7878 \
  --project myapp=~/github/myapp
```

Then approve the host once, from wherever you administer the server: `cnoc hosts approve NAME`.

The installer clones Cnoc to `~/.local/share/cnoc/app`, puts a `cnoc` command in `~/.local/bin`, writes `~/.config/cnoc/client.json` and starts the client as a user service: systemd on Linux, launchd on macOS.

- Repeat `--project NAME=PATH` for each checkout. `--resource gpu=1` offers a resource (default `slots=1`), and `--name` overrides the hostname.
- Running it again updates the code and restarts the client. Running sessions are not interrupted, and the existing config is kept unless you pass `--force`.
- The service does not read your shell profile. It gets the `PATH` the installer saw; on Linux, put any other variables in `~/.config/cnoc/client.env`.
- `--uninstall` removes the service and the code, and keeps the config and host key.

There is no installer for the server yet; see [Quick start](#quick-start).

## How it fits together

```
 submitters, dashboards ── HTTP ──►┌──────────────────────────┐
                                   │          server          │  one process, one SQLite file
 job repo (git) ── cnoc ingest ──►│  queue · ledger · policy │
                                   └────────────▲─────────────┘
                                                │ WebSocket, opened by the client
                              jobs, cancels     ▼   ▲  status, resources, results
                                   ┌────────────┴─────────────┐
                                   │    client (one per host) │
                                   └──────┬───────────▲───────┘
                              tmux session │           │ cnoc done / fail / progress
                                   ┌──────▼───────────┴───────┐
                                   │       agent harness      │
                                   └──────────────────────────┘
```

- **One server.** If it is down, nothing new starts. Clients finish what they are running and report when it is back.
- **Clients only dial out.** No inbound ports on the hosts.
- **Sessions live in tmux,** not in the client. A client restart or upgrade does not interrupt them, and you can attach to watch.

## A job

```
---
id: myapp/1234
resources: { slots: 1, claude-max: 1 }
depends: [myapp/1201]
time: 4h
---
FROM myapp
HARNESS claude --model opus
PROMPT "/goal run a lane to implement #1234"
```

The front matter is what the server schedules on. The body is what the client runs.

| Front matter | Meaning |
|---|---|
| `id` | Required, chosen by the submitter, never reused. Dependencies refer to it. |
| `resources` | Named counters the job holds while it runs. Default `{ slots: 1 }`. |
| `requires` | Extra host features, such as `linux` or `zfs`. |
| `depends` | Job ids that must be `done` first. |
| `priority` | Higher runs first. Default 0. |
| `time` | Wall-clock limit for the whole job, such as `90m` or `4h`. |
| `labels` | Free-form; Cnoc ignores them. |

| Instruction | Meaning |
|---|---|
| `FROM project` | The project. Each host maps the name to its own checkout. |
| `HARNESS name [args]` | The harness for the prompts that follow. |
| `PROMPT "text"` | One session. Several prompts make a multi-stage job. `PROMPT <<END … END` for long text. |
| `ENV NAME=value` | Environment for every session of the job. Not for secrets. |

`RUN`, `WORKTREE` and `WORKDIR` are reserved and rejected for now. `cnoc check FILE...` validates Jobfiles with no server, for use in a repository check.

## Reporting a result

Every session gets a `cnoc` command on its `PATH`:

```
cnoc progress "tests are green"
cnoc done "opened PR #88"
cnoc fail "the schema migration needs a decision"
```

The built-in adapters append these instructions to the prompt. A project can also call them from a stop hook. A session that ends without reporting is `failed` with reason `no-result`.

## Harness adapters

`HARNESS claude` expands to a file in the same syntax, [harness/claude.harness](harness/claude.harness):

```
REQUIRE claude
TMUX claude --dangerously-skip-permissions ${ARGS} ${TASK}
EXPECT "Claude Code v" TIMEOUT 45
STOP TYPE "/exit" Enter
```

| Instruction | Meaning |
|---|---|
| `REQUIRE bin` | The host only offers this harness if `bin` is on its `PATH`. |
| `TMUX command` | Starts the session. `${PROMPT}`, `${TASK}` (prompt plus reporting instructions), `${ARGS}`, `${JOB}`, `${ATTEMPT}`, `${STAGE}` are filled in. |
| `EXPECT "regex" [TIMEOUT n]` | Waits for the screen to match. On timeout the job fails and the reason quotes what the screen showed. |
| `TYPE "text" Key...` | Types text and key names (`Enter`, `Escape`, `C-c`). |
| `SLEEP n` | Waits. |
| `STOP ...` | A `TYPE` or `SLEEP` to run when the session is asked to end, before it is killed. |

Adding a harness is adding a file. Put your own in a directory and point `harness_dir` at it in the client config. Built in: `claude`, `codex` (not yet exercised end to end) and `shell`, which runs the prompt as a shell command.

## Quick start

Requires [Bun](https://bun.sh) and tmux. Tested on macOS and Linux (including WSL2), Bun 1.4.4 and 1.4.5, tmux 3.4 and 3.7; older versions are untried.

**Server**, on a machine the hosts can reach:

```
git clone https://github.com/finbheara/cnoc && cd cnoc && bun install
bun src/cli.ts server --host 0.0.0.0
```

It prints where it wrote the admin token. Put TLS in front of it, or keep it on a private network; the server speaks plain HTTP. Keeping it running is up to you for now.

**Each host:** run the [installer](#install-a-client). The client generates a key on first start and waits to be approved. The config it writes looks like [examples/client.json](examples/client.json).

**Anywhere you administer from**, the `cnoc` command needs the server's address and admin token, either in the environment or in `~/.config/cnoc/cli.json` as `{ "url", "token" }`. Without the installer, `cnoc` is `bun /path/to/cnoc/src/cli.ts`.

```
export CNOC_URL=http://controller.example:7878 CNOC_TOKEN=...
cnoc hosts
cnoc hosts approve workbox
```

**Submit and watch:**

```
cnoc submit examples/implement-and-review.job
cnoc queue
cnoc show myapp/1234
cnoc events --follow
cnoc attach 7          # on the host: read-only view of attempt 7's session
```

## Resources

A resource is a name and a count. A host offers some (`"resources": { "slots": 3, "gpu": 1 }`), a job asks for some, and the server never hands a host more than it offers. A host that does not list a name has none of it, which makes counted names work as licences.

A **pool** is a counter shared by the whole fleet, set in the server config (`"pools": { "claude-max": 3 }`). A job that asks for a pool's name draws from the pool wherever it runs. Use it for a subscription shared across hosts.

Placement is pluggable: order the queue, filter hosts, score the survivors. The default is priority then age, the least-loaded eligible host, and a hold-back so a large job that has waited ten minutes is not starved by small ones. See [examples/policy.ts](examples/policy.ts).

## Job states

`blocked` → `queued` → `assigned` → `running` → `done` | `failed` | `cancelled`

`blocked` means a dependency is not `done` yet. Nothing is ever pre-empted: once a job is running it finishes, fails, hits its time limit or is cancelled.

## The changelog

Every state change is one numbered event. Read it three ways:

- `GET /v1/events?after=SEQ&wait=30` — a page, or a long-poll.
- `GET /v1/events/stream?after=SEQ` — server-sent events, resumable.
- `POST /v1/subscriptions { "url", "types" }` — a webhook, delivered in order, at least once, signed with `X-Cnoc-Signature`.

`GET /v1/state` returns a full snapshot with the `as_of` sequence to tail from. A planner is a subscriber to `job.terminal` that submits more jobs.

## Jobs from git

`cnoc ingest DIR --interval 60` pulls a checkout and submits every `*.job` under `DIR/jobs` as one batch. Submitting the same file again does nothing, and a changed file is refused, so merged job files are immutable. Whoever can merge to that repository can run prompts on your hosts; protect the branch accordingly.

## Development

```
bun install
bun run am-i-done     # typecheck and tests; the end-to-end tests need tmux
```
