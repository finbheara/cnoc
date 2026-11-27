import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { specTempDir } from "../testkit";
import { DEFAULT_RUN_TIMEOUT_MS, StepRunner } from "./runner";
import type { Logger, Step } from "./types";

// Tracked temp dirs: every `mkdtempSync` in this file goes through `tempDir()`
// so afterEach can clean them up. Otherwise /tmp accumulates `runner-shell-*`
// dirs across runs.
const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const d = specTempDir(prefix);
  tempDirs.push(d);
  return d;
}
afterEach(() => {
  while (tempDirs.length) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function makeLog(): { logger: Logger; entries: string[] } {
  const entries: string[] = [];
  const sink: Logger = {
    debug: (...a) => entries.push(`D ${a.join(" ")}`),
    info: (...a) => entries.push(`I ${a.join(" ")}`),
    warn: (...a) => entries.push(`W ${a.join(" ")}`),
    error: (...a) => entries.push(`E ${a.join(" ")}`),
  };
  return { logger: sink, entries };
}

function ok(name: string): Step {
  return { name, description: "x", command: async () => ({ success: true }) };
}

function fail(name: string, msg = "boom"): Step {
  return {
    name,
    description: "x",
    command: async ({ logger }) => {
      logger.error(msg);
      return { success: false, error: msg };
    },
  };
}

// ===== runShell: spawns a real child process via step.command: string =====
//
// Uses a temp-dir shim binary to keep the test hermetic. The shim writes to
// stdout/stderr (covering the runShell data handlers) and exits with a
// configured code (covering the close handler's success / non-zero / null
// branches). A non-existent command exercises the spawn `error` branch.

function shimScript(opts: { stdout?: string; stderr?: string; code: number }): string {
  const dir = tempDir("runner-shell-");
  const path = join(dir, "shim");
  const stdout = (opts.stdout ?? "").replace(/'/g, "'\\''");
  const stderr = (opts.stderr ?? "").replace(/'/g, "'\\''");
  writeFileSync(
    path,
    `#!/usr/bin/env bash
[ -n '${stdout}' ] && printf '%s\\n' '${stdout}'
[ -n '${stderr}' ] && printf '%s\\n' '${stderr}' >&2
exit ${opts.code}
`,
    { mode: 0o755 },
  );
  return path;
}

describe("StepRunner — runShell (string command)", () => {
  it("empty command string returns success=false with 'empty command'", async () => {
    const { logger } = makeLog();
    const empty: Step = { name: "empty", description: "x", command: "   " };
    const report = await new StepRunner({ logger }).add(empty).run();
    expect(report.success).toBe(false);
    expect(report.failures[0]?.error).toBe("empty command");
  });

  it("exit 0 from a real subprocess is a success", async () => {
    const { logger } = makeLog();
    const shim = shimScript({ stdout: "hello-stdout", code: 0 });
    const step: Step = { name: "shim-ok", description: "x", command: shim };
    const report = await new StepRunner({ logger }).add(step).run();
    expect(report.success).toBe(true);
    expect(report.failures).toHaveLength(0);
  });

  it("non-zero exit is a failure with 'exit N' error and stderr is replayed", async () => {
    const { logger, entries } = makeLog();
    const shim = shimScript({ stdout: "out-line", stderr: "err-line", code: 3 });
    const step: Step = { name: "shim-fail", description: "x", command: shim };
    const report = await new StepRunner({ logger }).add(step).run();
    expect(report.success).toBe(false);
    expect(report.failures[0]?.error).toBe("exit 3");
    // On failure the captured output is replayed to the sink — both stdout (info)
    // and stderr (error) channels should appear.
    expect(entries.some((e) => e.startsWith("I ") && e.includes("out-line"))).toBe(true);
    expect(entries.some((e) => e.startsWith("E ") && e.includes("err-line"))).toBe(true);
  });

  it("non-existent binary triggers the spawn error branch", async () => {
    const { logger } = makeLog();
    const step: Step = {
      name: "no-such-bin",
      description: "x",
      command: "/this/path/definitely/does/not/exist-xyz-12345",
    };
    const report = await new StepRunner({ logger }).add(step).run();
    expect(report.success).toBe(false);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.error).toBeTruthy();
  });

  it("appends step.args to the shell command's argv", async () => {
    const { logger } = makeLog();
    const dir = tempDir("runner-shell-args-");
    const path = join(dir, "argshim");
    // The shim echoes its argv joined; we'll fail it unless the arg shows up.
    writeFileSync(
      path,
      `#!/usr/bin/env bash
case "$@" in
  *STEP_PROBE_X*) echo "found" && exit 0 ;;
  *) echo "missing: $@" >&2 && exit 5 ;;
esac
`,
      { mode: 0o755 },
    );
    const step: Step = {
      name: "argshim",
      description: "x",
      command: path,
      args: ["STEP_PROBE_X"],
    };
    const report = await new StepRunner({ logger }).add(step).run();
    expect(report.success).toBe(true);
  });

  it("drops undefined env values before spawning (no upstream `unset` needed)", async () => {
    const { logger } = makeLog();
    const dir = tempDir("runner-shell-env-");
    const path = join(dir, "envshim");
    writeFileSync(
      path,
      `#!/usr/bin/env bash
# Bash converts an "unset" env var to empty; an explicit "undefined"
# literal here would fail spawn() before reaching the script.
[ "$STEP_DEFINED" = "yes" ] || exit 7
exit 0
`,
      { mode: 0o755 },
    );
    const step: Step = {
      name: "envshim",
      description: "x",
      command: path,
      env: {
        STEP_DEFINED: "yes",
        // The runner's runShell drops undefined values pre-spawn; if it didn't,
        // node:child_process.spawn would throw before ever calling exec.
        STEP_DROPPED: undefined as unknown as string,
      },
    };
    const report = await new StepRunner({ logger }).add(step).run();
    expect(report.success).toBe(true);
  });
});

describe("StepRunner — wall-clock deadline", () => {
  // Small, explicit budgets: every test here ends on a CONDITION (the deadline
  // firing, or the run completing), never on a fixed wait for wall time.
  const DEADLINE_MS = 150;

  /** A step that never resolves — the only way out is the deadline. */
  function wedged(name: string, emit?: string): Step {
    return {
      name,
      description: "x",
      command: async ({ logger }) => {
        if (emit) logger.info(emit);
        await new Promise<never>(() => {});
        return { success: true };
      },
    };
  }

  function killSpy() {
    const calls: Array<{ graceMs?: number }> = [];
    const killTree = async (opts: { graceMs?: number } = {}) => {
      calls.push(opts);
      return { killed: [], survivors: [] };
    };
    return { killTree, calls };
  }

  it("aborts a wedged run at the deadline and names the in-flight step", async () => {
    const { logger, entries } = makeLog();
    const spy = killSpy();
    const report = await new StepRunner({ logger, timeoutMs: DEADLINE_MS, killTree: spy.killTree })
      .add(ok("typecheck"), wedged("test-parallel"))
      .run();

    expect(report.timedOut).toBe(true);
    expect(report.success).toBe(false);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.step.name).toBe("test-parallel");
    expect(report.failures[0]?.error).toContain("deadline");
    // The operator must be able to see WHICH step and for HOW LONG.
    const banner = entries.filter((e) => e.startsWith("E "));
    expect(banner.some((e) => e.includes("wall-clock deadline"))).toBe(true);
    expect(banner.some((e) => e.includes("in-flight") && e.includes("test-parallel"))).toBe(true);
    expect(banner.some((e) => e.includes("stuck for"))).toBe(true);
    // And be able to resume from it.
    expect(banner.some((e) => e.includes("--from 2"))).toBe(true);
  });

  it("flushes the wedged step's captured output instead of leaving an empty log", async () => {
    // a past 31-minute wedge produced a 1171-byte artefact because the
    // capture buffer is only replayed when a step *completes*.
    const { logger, entries } = makeLog();
    const spy = killSpy();
    const report = await new StepRunner({ logger, timeoutMs: DEADLINE_MS, killTree: spy.killTree })
      .add(wedged("test-parallel", "partial-progress-line"))
      .run();

    expect(report.timedOut).toBe(true);
    expect(entries.some((e) => e.includes("partial-progress-line"))).toBe(true);
    // Exactly once — the deadline dump must not double-print.
    expect(entries.filter((e) => e.includes("partial-progress-line"))).toHaveLength(1);
  });

  it("fires on elapsed time even when the wall clock steps back mid-run", async () => {
    // The host this suite runs on steps its wall clock back ~7 s every ~32 s.
    // A deadline computed from Date.now() re-armed past such a step, so the
    // 150 ms deadline outlived bun's 5 s test timeout. Here the step is forced:
    // once the step is in flight, Date.now() is an hour back and frozen
    // (setSystemTime moves only Date, not timers or performance.now()). On a
    // wall-clock deadline this test can never finish; on a monotonic one it
    // ends at DEADLINE_MS.
    const { logger } = makeLog();
    const spy = killSpy();
    const stepBack: Step = {
      name: "test-parallel",
      description: "x",
      command: async () => {
        setSystemTime(new Date(Date.now() - 3_600_000));
        await new Promise<never>(() => {});
        return { success: true };
      },
    };
    try {
      const report = await new StepRunner({ logger, timeoutMs: DEADLINE_MS, killTree: spy.killTree })
        .add(stepBack)
        .run();
      expect(report.timedOut).toBe(true);
      expect(spy.calls).toHaveLength(1);
    } finally {
      setSystemTime();
    }
  });

  it("kills the child process tree exactly once on expiry", async () => {
    const { logger } = makeLog();
    const spy = killSpy();
    await new StepRunner({ logger, timeoutMs: DEADLINE_MS, killTree: spy.killTree }).add(wedged("test-parallel")).run();
    expect(spy.calls).toHaveLength(1);
  });

  it("says so out loud when a process group survives SIGKILL", async () => {
    const { logger, entries } = makeLog();
    const killTree = async () => ({ killed: [4242], survivors: [4242] });
    await new StepRunner({ logger, timeoutMs: DEADLINE_MS, killTree }).add(wedged("test-parallel")).run();
    expect(entries.some((e) => e.includes("survived SIGKILL") && e.includes("4242"))).toBe(true);
  });

  it("reads the budget from AM_I_DONE_TIMEOUT_MS", async () => {
    const { logger } = makeLog();
    const spy = killSpy();
    const report = await new StepRunner({
      logger,
      env: { AM_I_DONE_TIMEOUT_MS: String(DEADLINE_MS) },
      killTree: spy.killTree,
    })
      .add(wedged("test-parallel"))
      .run();
    expect(report.timedOut).toBe(true);
  });

  it("a non-positive budget disables the deadline entirely", async () => {
    const { logger } = makeLog();
    const spy = killSpy();
    const report = await new StepRunner({ logger, env: { AM_I_DONE_TIMEOUT_MS: "0" }, killTree: spy.killTree })
      .add(ok("typecheck"), ok("lint"))
      .run();
    expect(report.success).toBe(true);
    expect(report.timedOut).toBeUndefined();
    expect(spy.calls).toHaveLength(0);
  });

  it("leaves a healthy run untouched — nothing is signalled when steps finish", async () => {
    const { logger } = makeLog();
    const spy = killSpy();
    const report = await new StepRunner({ logger, timeoutMs: DEADLINE_MS, killTree: spy.killTree })
      .add(ok("typecheck"))
      .run();
    expect(report.success).toBe(true);
    expect(report.timedOut).toBeUndefined();
    expect(spy.calls).toHaveLength(0);
  });
});

describe("default run budget", () => {
  it("defaults to a 600s ceiling", () => {
    // The CI workflow sets no deadline of its own, so the default is the one value to pin.
    expect(DEFAULT_RUN_TIMEOUT_MS).toBe(600_000);
  });
});
