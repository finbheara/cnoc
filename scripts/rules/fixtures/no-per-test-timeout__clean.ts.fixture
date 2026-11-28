/**
 * @rule no-per-test-timeout
 * @expect 0
 * @path src/example.spec.ts
 *
 * The file-level knob, two-argument tests and their modifiers, describe, hooks with a timeout
 * argument, and an unrelated three-argument call: none of these is a per-test option.
 */
import { beforeAll, describe, expect, it, setDefaultTimeout, test } from "bun:test";

// A real `uvx` cold start: the file, not one test, says it needs longer.
const EXAMPLE_SPEC_TIMEOUT_MS = 60_000;
setDefaultTimeout(EXAMPLE_SPEC_TIMEOUT_MS);

const HOOK_MS = 1_000;
beforeAll(() => undefined, HOOK_MS);

function pick(a: number, b: number, c: number): number {
  return a + b + c;
}

describe("group", () => {
  test("plain", () => expect(pick(1, 2, 3)).toBe(6));
  it.only("only", () => expect(1).toBe(1));
  test.if(true)("conditional", () => expect(1).toBe(1));
  test.each([1, 2])("each %p", (n) => expect(n).toBeGreaterThan(0));
});
