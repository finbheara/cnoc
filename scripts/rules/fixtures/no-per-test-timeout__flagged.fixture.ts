/**
 * @rule no-per-test-timeout
 * @expect 6
 * @path src/example.spec.ts
 *
 * Six per-test options: a number, a named constant, `{ timeout }`, `{ retry }`, and the
 * `.skip` and `.each(table)` forms. Each third argument is flagged.
 */
import { expect, it, test } from "bun:test";

const SLOW_MS = 30_000;

test("number", async () => {
  expect(1).toBe(1);
}, 120_000);

it("named constant", () => {
  expect(1).toBe(1);
}, SLOW_MS);

test("object timeout", () => expect(1).toBe(1), { timeout: 10_000 });

test("retry absorbs a flake", () => expect(1).toBe(1), { retry: 3 });

test.skip("skip form", () => expect(1).toBe(1), 9_000);

test.each([1, 2])("each form %p", (n) => expect(n).toBeGreaterThan(0), 9_000);
