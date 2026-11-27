/**
 * Runs one attempt: each stage is a harness session in tmux, driven by the adapter's
 * steps and watched until it reports a result, exits, is cancelled or runs out of time.
 */
import { type Adapter, type Step, expand, shellQuote } from "../jobfile";
import type { AttemptEnd, JobSpec, StageResult, Usage } from "../protocol";
import { SESSION_VARS } from "../usage";
import type { Tmux } from "./tmux";

/** Persisted so a restarted client can pick the attempt up again. */
export interface AttemptState {
  attempt: number;
  spec: JobSpec;
  token: string;
  stage: number;
  /** launching: the session may be half set up. prompted: the harness has its prompt. */
  phase: "launching" | "prompted";
  deadline: number | null;
  results: StageResult[];
  /** A result the harness reported for the current stage, not yet acted on. */
  reported: StageResult | null;
  /** The latest usage snapshot (`cnoc usage`) for the current stage. Absent in state saved by older clients. */
  usage?: Usage | null;
}

export interface RunnerDeps {
  tmux: Tmux;
  adapter(name: string): Adapter | null;
  projectPath(name: string): string | null;
  /** Environment given to every session, on top of the job's own ENV. */
  baseEnv: Record<string, string>;
  save(): void;
  onStarted(attempt: number): void;
  writeLog(attempt: number, stage: number, text: string): void;
  pollMs: number;
}

export const REPORT =
  'When you finish, report once with the cnoc command the task above names. If it names none, run `cnoc done "<one-line summary>"`, ' +
  'or `cnoc fail "<reason>"` if it cannot be completed. Use `cnoc progress "<note>"` for milestones.';

export const sessionName = (attempt: number, stage: number): string => `cnoc-${attempt}-${stage}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Variables that hold free text and must be shell-quoted inside a TMUX command line. */
const QUOTED = new Set(["PROMPT", "REPORT", "TASK"]);

type Verdict = { kind: "result" } | { kind: "end"; outcome: "failed" | "cancelled"; reason: string };

export class AttemptRunner {
  private cancelReason: string | null = null;

  constructor(
    readonly state: AttemptState,
    private deps: RunnerDeps,
    private resuming: boolean,
  ) {}

  cancel(reason: string): void {
    this.cancelReason ??= reason;
  }

  /** Called by the local API when the harness runs `cnoc done` or `cnoc fail`. First report wins. */
  report(result: StageResult): boolean {
    if (this.state.reported) return false;
    this.state.reported = result;
    this.deps.save();
    return true;
  }

  /** Called by the local API on `cnoc usage`. The latest snapshot for the stage is kept. */
  snapshot(usage: Usage): void {
    this.state.usage = usage;
    this.deps.save();
  }

  /** Ends the attempt after a stage that did not report, keeping its last usage snapshot as its result. */
  private endUnreported(outcome: "failed" | "cancelled", reason: string): AttemptEnd {
    const usage = this.state.usage;
    if (usage) this.state.results.push({ status: "failed", summary: reason, usage, reported: false });
    this.state.usage = null;
    return this.end(outcome, reason);
  }

  private end(outcome: AttemptEnd["outcome"], reason: string | null): AttemptEnd {
    return { attempt: this.state.attempt, outcome, reason, results: this.state.results };
  }

  async run(): Promise<AttemptEnd> {
    const { state: st, deps } = this;
    for (; st.stage < st.spec.stages.length; st.stage++) {
      const session = sessionName(st.attempt, st.stage);
      const resumed = this.resuming;
      this.resuming = false;
      if (resumed && st.phase === "launching") {
        await deps.tmux.kill(session);
        return this.endUnreported("failed", "client-restarted-during-launch");
      }
      if (!resumed) {
        st.phase = "launching";
        st.reported = null;
        st.usage = null;
        deps.save();
        try {
          await this.launch(session);
        } catch (e) {
          await this.close(session, false);
          if (this.cancelReason) return this.endUnreported("cancelled", this.cancelReason);
          return this.endUnreported("failed", `launch: ${(e as Error).message}`);
        }
        st.phase = "prompted";
        deps.save();
      }
      const verdict = await this.watch(session);
      await this.close(session, true);
      if (verdict.kind === "end") return this.endUnreported(verdict.outcome, verdict.reason);
      const result = st.reported as StageResult;
      if (!result.usage && st.usage) result.usage = st.usage;
      st.results.push(result);
      st.reported = null;
      st.usage = null;
      if (result.status === "failed") return this.end("failed", `stage ${st.stage + 1} failed: ${result.summary}`);
    }
    return this.end("done", null);
  }

  private vars(): Record<string, string> {
    const st = this.state;
    const stage = st.spec.stages[st.stage];
    const prompt = stage?.prompt ?? "";
    return {
      PROMPT: prompt,
      REPORT,
      TASK: `${prompt}\n\n${REPORT}`,
      ARGS: stage?.args ?? "",
      JOB: st.spec.id,
      ATTEMPT: String(st.attempt),
      STAGE: String(st.stage + 1),
    };
  }

  private async launch(session: string): Promise<void> {
    const { state: st, deps } = this;
    const stage = st.spec.stages[st.stage];
    if (!stage) throw new Error("no such stage");
    const adapter = deps.adapter(stage.harness);
    if (!adapter) throw new Error(`no adapter for harness ${stage.harness}`);
    const cwd = deps.projectPath(st.spec.project);
    if (!cwd) throw new Error(`project ${st.spec.project} is not configured on this host`);
    await deps.tmux.kill(session);
    for (const step of adapter.steps) {
      if (this.cancelReason) throw new Error("cancelled");
      if (step.op === "tmux") {
        const cmd = expand(step.cmd, this.vars(), (name, v) => (QUOTED.has(name) ? shellQuote(v) : v));
        const env = {
          // A client started from inside a harness session must not hand that session's id to its jobs,
          // or their reports would carry its usage. A job's ENV may still set one.
          ...Object.fromEntries(SESSION_VARS.filter((v) => process.env[v] !== undefined).map((v) => [v, ""])),
          ...st.spec.env,
          ...deps.baseEnv,
          CNOC_TOKEN: st.token,
          CNOC_JOB: st.spec.id,
          CNOC_ATTEMPT: String(st.attempt),
          CNOC_STAGE: String(st.stage + 1),
        };
        await deps.tmux.newSession(session, cwd, env, cmd);
        if (st.stage === 0) deps.onStarted(st.attempt);
      } else {
        await this.terminal(session, step);
      }
    }
  }

  private async terminal(session: string, step: Step): Promise<void> {
    const tmux = this.deps.tmux;
    if (step.op === "sleep") {
      await sleep(step.s * 1000);
    } else if (step.op === "type") {
      for (const k of step.keys) {
        if ("text" in k) await tmux.sendText(session, expand(k.text, this.vars()));
        else await tmux.sendKey(session, k.key);
      }
    } else if (step.op === "expect") {
      const re = new RegExp(step.pattern);
      const until = Date.now() + step.timeout_s * 1000;
      for (;;) {
        const screen = await tmux.capture(session);
        if (re.test(screen)) return;
        if (this.cancelReason) throw new Error("cancelled");
        // What the screen showed instead is usually the whole diagnosis (a login or trust prompt, say).
        const saw = screen
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(-3)
          .join(" | ")
          .slice(0, 300);
        if ((await tmux.status(session)).state !== "running")
          throw new Error(`session ended while waiting for /${step.pattern}/; screen: ${saw}`);
        if (Date.now() > until)
          throw new Error(`timed out after ${step.timeout_s}s waiting for /${step.pattern}/; screen: ${saw}`);
        await sleep(Math.min(500, this.deps.pollMs));
      }
    }
  }

  private async watch(session: string): Promise<Verdict> {
    const st = this.state;
    for (;;) {
      if (st.reported) return { kind: "result" };
      if (this.cancelReason) return { kind: "end", outcome: "cancelled", reason: this.cancelReason };
      if (st.deadline !== null && Date.now() > st.deadline)
        return { kind: "end", outcome: "failed", reason: "timeout" };
      const status = await this.deps.tmux.status(session);
      if (status.state !== "running") {
        // The report and the exit can land in either order; give the report a moment.
        await sleep(Math.min(300, this.deps.pollMs));
        if (st.reported) return { kind: "result" };
        const how = status.state === "dead" ? `exit ${status.exit}` : "session-lost";
        return { kind: "end", outcome: "failed", reason: `no-result (${how})` };
      }
      await sleep(this.deps.pollMs);
    }
  }

  /** Saves the scrollback, lets the harness exit cleanly if it is still up, then removes the session. */
  private async close(session: string, graceful: boolean): Promise<void> {
    const { deps, state: st } = this;
    const tmux = deps.tmux;
    if ((await tmux.status(session)).state === "gone") return;
    const adapter = deps.adapter(st.spec.stages[st.stage]?.harness ?? "");
    if (graceful && adapter?.stop.length && (await tmux.status(session)).state === "running") {
      try {
        for (const step of adapter.stop) await this.terminal(session, step);
      } catch {
        // The session is being removed either way.
      }
      const until = Date.now() + 5000;
      while (Date.now() < until && (await tmux.status(session)).state === "running") await sleep(200);
    }
    deps.writeLog(st.attempt, st.stage, await tmux.capture(session, true));
    await tmux.kill(session);
  }
}
