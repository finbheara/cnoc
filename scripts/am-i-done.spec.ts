import { describe, expect, it } from "bun:test";

import { CI, COMPREHENSIVE, PRE_COMMIT, PRE_PUSH, jobfilesStep, parseFlag, parseRepeatableFlag } from "./am-i-done";

const names = (steps: { name: string }[]): string[] => steps.map((s) => s.name);
const STATIC = ["install", "typecheck", "lint", "doing-it-wrong", "jobfiles", "shell"];

describe("step lists", () => {
  it("pre-commit is static only; pre-push and --ci add the test suite", () => {
    expect(names(PRE_COMMIT)).toEqual(STATIC);
    expect(names(PRE_PUSH)).toEqual([...STATIC, "test"]);
    expect(names(CI)).toEqual([...STATIC, "test"]);
  });

  it("only the default mode lets the linter rewrite files", () => {
    const lint = (steps: { name: string; command: unknown }[]) => steps.find((s) => s.name === "lint")?.command;
    expect(lint(COMPREHENSIVE)).toBe("bunx biome check --write .");
    for (const mode of [PRE_COMMIT, PRE_PUSH, CI]) expect(lint(mode)).toBe("bunx biome check .");
    expect(names(COMPREHENSIVE)).toEqual([...STATIC, "test"]);
  });
});

describe("jobfiles step", () => {
  it("parses every example in the repository, templates included", async () => {
    const lines: string[] = [];
    const push = (...a: unknown[]): void => void lines.push(a.join(" "));
    const logger = { debug: push, info: push, warn: push, error: push };
    expect(await jobfilesStep({ args: [], env: {}, logger })).toEqual({ success: true, error: undefined });
    expect(lines).toEqual([]);
  });
});

describe("flags", () => {
  it("parseFlag reads the value after a flag, and nothing for a trailing or missing one", () => {
    expect(parseFlag(["--from", "3", "--only"], "--from")).toBe("3");
    expect(parseFlag(["--from", "3", "--only"], "--only")).toBeUndefined();
    expect(parseFlag([], "--from")).toBeUndefined();
  });

  it("parseRepeatableFlag collects every occurrence", () => {
    expect(parseRepeatableFlag(["--skip", "a", "--verbose", "--skip", "b", "--skip"], "--skip")).toEqual(["a", "b"]);
  });
});
