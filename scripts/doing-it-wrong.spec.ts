/**
 * The rule sweep over the real tree, in-process: the same `runRules` am-i-done runs. A rule that lands lands at zero
 * violations, so the tree must be clean; and every rule this repo promises is registered.
 */
import { describe, expect, test } from "bun:test";
import type { Logger } from "./_runner/types";
import { doingItWrongStep, reportWarnings, runRules } from "./doing-it-wrong";
import type { PatternRule, Violation } from "./rules/_engine/rule";

function quiet(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const push = (...a: unknown[]): void => void lines.push(a.join(" "));
  return { lines, debug: push, info: push, warn: push, error: push };
}

const PROMISED = [
  "claude-md-size",
  "dotw-todo-needs-issue",
  "file-size",
  "named-timeouts",
  "no-as-any",
  "no-import-cycles",
  "no-per-test-timeout",
  "no-process-kill",
  "no-raw-mkdtemp",
  "prod-empty-catch",
  "shell-injection",
  "test-empty-catch",
  "test-filtered-assertion",
  "test-timeouts",
  "test-trivial-bound",
];

describe("doing-it-wrong over this repository", () => {
  test("the tree is clean and no anchor is missing", async () => {
    const r = await runRules({}, quiet());
    expect({
      violations: r.violations.map((v) => `${v.rule.id} ${v.file}:${v.line}`),
      warnings: r.warnings.length,
      missingAnchors: r.missingAnchors,
      malformedTodos: r.malformedTodos,
    }).toEqual({ violations: [], warnings: 0, missingAnchors: [], malformedTodos: [] });
  });

  test("every promised rule is registered, and nothing else", async () => {
    const r = await runRules({ ruleId: "file-size" }, quiet());
    expect(r.ruleCount).toBe(PROMISED.length);
    const { loadAllRules } = await import("./rules/index");
    expect((await loadAllRules()).map((rule) => rule.id)).toEqual(PROMISED);
  });

  test("the governance rules do inspection work on the real tree (none passes by matching nothing)", async () => {
    const r = await runRules({}, quiet());
    for (const id of ["file-size", "claude-md-size", "no-import-cycles"]) expect(r.silentPassRules).not.toContain(id);
  });

  test("an unknown rule id is a failure, not an empty pass", async () => {
    const log = quiet();
    const r = await runRules({ ruleId: "no-such-rule" }, log);
    expect(r.unknownRule).toBe(true);
    expect(log.lines.join("\n")).toContain("not registered");
  });

  test("the am-i-done step passes on the clean tree", async () => {
    expect(await doingItWrongStep({ args: [], env: {}, logger: quiet() })).toEqual({ success: true, error: undefined });
  });

  test("warnings are counted, and listed in full on request", () => {
    const rule: PatternRule = { id: "w", kind: "pattern", pattern: /x/, scold: "s", guidance: ["g"], blocking: false };
    const w: Violation = { file: "a.ts", line: 1, column: 2, snippet: "x", rule };
    const brief = quiet();
    reportWarnings([w], brief, false);
    expect(brief.lines.join("\n")).toContain("bun doing-it-wrong --rule w");
    const full = quiet();
    reportWarnings([w, w], full, true);
    expect(full.lines.join("\n").match(/a\.ts:1:2/g)?.length).toBe(2);
  });
});
