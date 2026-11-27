# cnoc

Batch scheduling of agent harness sessions across persistent hosts: one server with the queue, a
client on each host that runs jobs in tmux. Read `README.md` for what it does, `docs/SPEC.md` for
the design and its reasons, `docs/PLAN.md` for what is and is not built.

## The gate

`bun am-i-done` is the one definition of done. Run it before saying work is finished.

- `bun am-i-done`: everything. Install, typecheck, lint (with fixes), the rules, the example
  Jobfiles, shellcheck, the whole test suite.
- `bun am-i-done --pre-commit` / `--pre-push`: what the git hooks run (`.git-hooks/`, installed by
  `bun install`). Never bypass them with `--no-verify`.
- `bun am-i-done --ci`: the same list as `--pre-push`. Run it before asking for a merge.
- `--only NAME`, `--from NAME`, `--skip NAME` to iterate on one step.
- `bun doing-it-wrong --list`: the rules. Each prints its own fix; read it instead of guessing.
  How to write or suppress one: `scripts/rules/README.md`.
- In an agent session the output goes to `build/am-i-done-<time>.txt` and only the path is shown
  on failure. Read that file; do not rerun with `--verbose` to see it.

## Layout

- `src/protocol.ts`: the job model and the client/server messages. `src/jobfile.ts`: the parser.
- `src/server/`: `store.ts` (SQLite, every mutation appends a changelog event), `scheduler.ts`
  (pure placement), `server.ts` (HTTP, WebSocket, reconciliation).
- `src/client/`: `client.ts` (connection, local socket for the harness), `runner.ts` (one
  attempt), `tmux.ts`.
- `test/`: unit tests per module and `e2e.test.ts`, which runs a real server, real clients and
  real tmux sessions.
- `scripts/`: the gate. `harness/`: adapter files. `examples/`: Jobfiles and a template.

## Tests

- No per-test timeout or retry (the third argument to `test`). A file that needs longer says so
  once with `setDefaultTimeout(NAMED_MS)` and a comment.
- No fixed sleeps: poll a condition (`until` in the end-to-end tests) or pass a named interval.
- Temp directories only through `scripts/testkit` (`specTempDir`, `tmpScope`, `tmpDir`).
- A flake blocks. Never skip it, retry it or widen a timeout; find the cause.
- The end-to-end tests need tmux on `PATH`.

## Conventions

- Typecheck is `bun check`. There is no `tsc`.
- A change to the Jobfile syntax, the wire messages or the HTTP API also changes `docs/SPEC.md`.
- This repository is public. No host names, private project names or credentials in code, tests,
  examples or docs.
- Caps live in `scripts/rules/_config/limits.ts`. Changing one is the owner's decision.
