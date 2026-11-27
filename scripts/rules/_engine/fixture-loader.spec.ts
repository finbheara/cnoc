import { describe, expect, test } from "bun:test";

import { blankJsDocBlocks, blankLineFrontmatter, parseFrontmatter } from "./fixture-loader";

describe("parseFrontmatter (TypeScript fixtures)", () => {
  const ts = `/**
 * @rule my-rule
 * @expect 2
 * @path packages/a/src/x.ts
 * @with packages/a/src/x.spec.ts
 * @with packages/a/src/y.ts
 */
export const x = 1;
`;

  test("reads rule, expect, path and repeated @with", () => {
    expect(parseFrontmatter("my-rule__case.fixture.ts", ts)).toEqual({
      rule: "my-rule",
      expect: 2,
      path: "packages/a/src/x.ts",
      with: ["packages/a/src/x.spec.ts", "packages/a/src/y.ts"],
    });
  });

  test("requires the file-name prefix to match @rule", () => {
    expect(() => parseFrontmatter("other__case.fixture.ts", ts)).toThrow("must match @rule");
  });

  test("rejects a non-integer @expect and a missing @path", () => {
    expect(() => parseFrontmatter("my-rule__a.fixture.ts", ts.replace("@expect 2", "@expect two"))).toThrow("@expect");
    expect(() => parseFrontmatter("my-rule__a.fixture.ts", ts.replace(" * @path packages/a/src/x.ts\n", ""))).toThrow(
      "missing @path",
    );
  });
});

describe("parseFrontmatter (non-TypeScript fixtures)", () => {
  const md = "#fixture @rule my-rule\n#fixture @expect 0\n#fixture @path .claude/agents/a.md\n# body\n";

  test("reads #fixture lines", () => {
    expect(parseFrontmatter("my-rule__case.fixture.md", md)).toEqual({
      rule: "my-rule",
      expect: 0,
      path: ".claude/agents/a.md",
      with: [],
    });
  });

  test("fails loudly when there is no frontmatter at all", () => {
    expect(() => parseFrontmatter("my-rule__case.fixture.md", "# just a body\n")).toThrow("missing frontmatter");
  });
});

describe("blanking preserves line numbers", () => {
  test("JSDoc blocks become whitespace but keep their newlines", () => {
    const src = "/**\n * @rule x\n */\nconst a = 1;\n";
    const out = blankJsDocBlocks(src);
    expect(out.split("\n")).toHaveLength(src.split("\n").length);
    expect(out).not.toContain("@rule");
    expect(out).toContain("const a = 1;");
  });

  test("#fixture lines are blanked in place", () => {
    const out = blankLineFrontmatter("#fixture @rule x\nreal line\n");
    expect(out.split("\n")[0]?.trim()).toBe("");
    expect(out.split("\n")[1]).toBe("real line");
  });
});
