/**
 * Rule: no-tmpdir-env
 *
 * A read of `process.env.TMPDIR` / `Bun.env.TMPDIR` (or `env["TMPDIR"]`) outside the temp owners.
 * The built-in `no-raw-temp` refuses `mkdtemp`, `tmpdir()`, `/tmp/` literals and `mktemp`; this
 * covers the remaining way to find the temp directory by hand, which the gate's earlier
 * `no-raw-mkdtemp` refused and the built-in does not.
 *
 * The owners are `scripts/testkit/tmp.ts` (spec temp dirs) and `scripts/testkit/scratch.ts`
 * (non-spec scratch). Everything else asks them for a directory.
 */
import { type Rule, type TSESTree, walk } from "am-i-done";

export const OWNERS: ReadonlySet<string> = new Set(["scripts/testkit/tmp.ts", "scripts/testkit/scratch.ts"]);

const isEnv = (node: TSESTree.Node): boolean =>
  node.type === "MemberExpression" &&
  !node.computed &&
  node.property.type === "Identifier" &&
  node.property.name === "env";

function readsTmpdir(node: TSESTree.MemberExpression): boolean {
  if (!node.computed)
    return node.property.type === "Identifier" && node.property.name === "TMPDIR" && isEnv(node.object);
  return node.property.type === "Literal" && node.property.value === "TMPDIR";
}

export default {
  id: "no-tmpdir-env",
  type: "check",
  category: "testing",
  ast: true,
  files: ["**/*.{ts,tsx}"],
  scold: "$TMPDIR read outside the temp owners: nothing removes what is made there",
  guidance: [
    'a spec: `specTempDir("x-")` from scripts/testkit (swept with the run, reaped by pid if the run is killed)',
    'a spec, one block: `using d = tmpDir("x-")` or `using fx = tmpScope(); fx.dir("x-")` (removed on return AND throw)',
    'production code or a script: `scratchDir("x-")` from scripts/testkit, then `.release()` when done',
    "the owners are scripts/testkit/tmp.ts and scripts/testkit/scratch.ts; do not add another",
  ],
  check(ctx) {
    if (OWNERS.has(ctx.file.relativePath)) return ctx.skipped();
    const lines = ctx.file.content.split("\n");
    walk(ctx.ast().program, (node) => {
      if (node.type !== "MemberExpression" || !readsTmpdir(node)) return;
      const { line, column } = node.loc.start;
      ctx.violated(line, column + 1, (lines[line - 1] ?? "").trim());
    });
    return ctx.checked();
  },
} satisfies Rule;
