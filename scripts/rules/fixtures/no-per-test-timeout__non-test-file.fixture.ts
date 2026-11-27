/**
 * @rule no-per-test-timeout
 * @expect 0
 * @path src/harness.ts
 *
 * Not a spec file: a function that happens to be called `test` with three arguments is not policed.
 */
function test(name: string, fn: () => void, budgetMs: number): void {
  if (name && budgetMs > 0) fn();
}
test("x", () => undefined, 5);
