# Plan

What exists, what does not, and the order to build the rest. The design is in [SPEC.md](SPEC.md).

## Built and tested

Tested means covered by `bun test`: 94 tests of cnoc itself, 27 of them end to end with a real server, real clients and real tmux sessions, and 274 specs of the gate.

| Area | What works |
|---|---|
| Jobfile | Front matter, `FROM` / `HARNESS` / `PROMPT` / `ENV`, heredocs, multi-stage jobs, line-numbered errors, `cnoc check`. |
| Adapters | `REQUIRE`, `TMUX`, `EXPECT`, `TYPE`, `SLEEP`, `STOP`; `claude`, `codex` and `shell` built in; extra directory via `harness_dir`. |
| Server | Atomic idempotent batch submit, dependency edges, cancel, requeue, abandon, drain, SQLite persistence. |
| Placement | Counted host resources, fleet pools, features, priority and age, decline backoff, starvation hold-back, policy loaded from a file. |
| Client | Outbound WebSocket with reconnect, key generation and enrollment, resource and load reporting, local socket for the harness, on-disk outbox. |
| Reconciliation | Client restart re-adopts sessions; results produced while the server was down are delivered later; vanished sessions and abandoned jobs are resolved. |
| Changelog | Numbered events, paging and long-poll, server-sent events, signed in-order webhooks, `/v1/state` snapshot. |
| Updates | The version is the commit a process runs. A client on another version takes no work, checks out exactly the server's commit from its clone's `origin` and exits for its service manager; failures back off across restarts, and `cnoc hosts` shows each host's version and why it has not caught up. |
| Git intake | `cnoc ingest` of a checkout's `jobs/` directory. |
| Templates | `ARG` and `--set`, saved on the server, each run a numbered job; add, list, show, run, remove. |
| When and where | `begin` (a time or a delay), `--on HOST` through a `host/NAME` feature, priority at submit and on a waiting job. |
| Gate | `bun am-i-done`: one ordered list of checks with a deadline, modes for the git hooks, and output kept out of an agent's context. `bun doing-it-wrong`: a rule engine with fifteen rules, each with fixtures. CI runs the gate on Linux and macOS, and both jobs are required on `main`. |
| Client install | `install.sh`: clone, `cnoc` command, config, and a systemd user unit or launchd agent that leaves tmux sessions alone on restart. |

Checked by hand, not by the test suite:

- A real Claude Code session through the `claude` adapter: launched, did the task, reported with `cnoc done`, exited on the stop sequence.
- The same adapter against a directory Claude Code had not been told to trust: failed after 45 seconds with the prompt text in the reason.
- Server and client as separate processes driven through the CLI, including host approval.
- The full test suite on Linux under WSL2 (Bun 1.4.5, tmux 3.4) and on a Debian container (Bun 1.4.4), as well as macOS.
- `install.sh` through `curl | bash` on Linux with systemd, and from a local copy on macOS with launchd: install, approval, a job that kept running across a restart of the client service, re-run, and on macOS uninstall.
- A server on one machine and a client on another: a shell job and a Claude Code job, both reported `done`.

Not exercised at all: the `codex` adapter, and more than one host connected at a time on separate machines.

## Not built

In rough order of value.

### 1. Make it installable

- **Server install.** The client has an installer; the server is a clone and a command you keep running yourself.
- **Launcher and payload split.** A small, rarely changing launcher that fetches a pinned version, verifies its hash and starts it. Today the update is built in: it checks out the commit the server names from the clone's own `origin`, so it is as safe as that repository and the server's choice of commit within it. Nothing verifies a signature, and the update code that runs is the old version's, so a broken update procedure has to be fixed by hand once.
- **Published package**, so a host does not need a clone.
- **TLS** in the server, or a documented reverse-proxy setup.

### 2. Accounting

- **Tokens and spend per attempt.** Nothing is collected yet. Options: an adapter `USAGE` step, the harness's own transcript, or a `mcx` adapter that already tracks it.
- **Per-job CPU and memory.** Only host-level load is measured.
- **Budgets** that stop a job, and quota-aware admission for shared subscriptions. Pools cap concurrency today, not consumption.
- **A stalled state** for a session waiting on a usage-limit reset. It currently just runs until its time limit.

### 3. Isolation and cleanup

- **`WORKTREE`** as an instruction, and a ZFS-clone equivalent, with matching teardown. Today a job runs in the project checkout and the harness's own prompts handle worktrees.
- **Footprint cleanup**: per-job temp directory, sweep of harness-private paths, a reaper for leftovers. Nothing is cleaned today except the tmux session.
- **`RUN`** for trusted authors, with a paired cleanup step.

### 4. Trust

- **Roles and more than one token.** There is one admin token. Outside submitters should be able to create held jobs that a person releases.
- **Hold and release.**
- **A directory repository** for host keys and version pins, so enrollment and upgrades are reviewed changes. Today approval is one CLI command and the version is whatever the server runs.
- **Signed changelog entries** and prompts encrypted to host keys. These matter only if the server is ever run by someone else.

### 5. Git as a full intake path

- The server merging job pull requests whose checks pass.
- Status pushed back to the repository.
- Cancel by a front-matter edit.

### 6. Reach

- **`mcx` adapter**, delegating to a local `mcpd`, then `mcx cluster join` as a second client of this protocol.
- **Logs from the server.** Scrollback is saved on the host; `cnoc log` should fetch it.
- **Remote attach.**
- **Automatic retry policy** per job. Requeue is manual.
- **Recurring schedules.** A template can be started at a time, once. Nothing starts it every night; an external timer calling `cnoc template run` does that today.
- **Templates from git.** `cnoc ingest` submits jobs only. Templates are added by hand.
- **Server backup or a warm spare.** The whole state is one SQLite file; nothing copies it yet.

### 7. The gate

Brought across without these parts of the gate it was taken from:

- **Coverage ratchet**, per-file spec accounting and per-file timing. `--ci` is the same list as `--pre-push` until they exist.
- **Stale-todo check.** A `dotw-todo` must name an issue, but nothing fails when that issue is closed.
- **Dead-module check.**
- **File size.** The cap is 750 lines because five files were over 400 when the rule landed. Splitting them and lowering the cap is open.

## Open questions

- **How long may a session sit idle?** A harness waiting at its prompt after finishing without reporting looks the same as one thinking. An idle-screen detector in the adapter would catch it sooner than the time limit.
- **Should a failed stage keep its session?** It is removed today and only the scrollback is kept. Keeping it would allow a person to attach and continue.
- **What is the version?** Answered: the git commit the process runs, which is a content hash of the tree, plus `-dirty` for uncommitted changes. Still compared for equality; pinning a fleet to something other than the server's own commit is the directory repository's job.
- **Where do host capacities live?** In each host's config today. A directory repository would make them reviewable, at the cost of a second place to edit.
