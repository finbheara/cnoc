import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { specTempDir } from "../../testkit";

import mkdtempRule from "../no-raw-mkdtemp.rule";
import { getPackageForPath, isTestFile, loadFiles } from "./file-loader";
import { evaluateRule } from "./rule";

describe("isTestFile", () => {
  test("detects .spec.ts", () => expect(isTestFile("foo.spec.ts")).toBe(true));
  test("detects .test.ts", () => expect(isTestFile("bar.test.ts")).toBe(true));
  test("detects .spec.tsx", () => expect(isTestFile("baz.spec.tsx")).toBe(true));
  test("rejects plain .ts", () => expect(isTestFile("foo.ts")).toBe(false));
  test("rejects .d.ts", () => expect(isTestFile("foo.d.ts")).toBe(false));
});

describe("getPackageForPath", () => {
  const root = "/repo";
  test("packages/core path", () =>
    expect(getPackageForPath(root, "/repo/packages/core/src/foo.ts")).toBe("packages/core"));
  test("src path", () => expect(getPackageForPath(root, "/repo/src/server/store.ts")).toBe("src"));
  test("scripts path", () => expect(getPackageForPath(root, "/repo/scripts/build.ts")).toBe("scripts"));
  test("test path", () => expect(getPackageForPath(root, "/repo/test/helper.ts")).toBe("test"));
  test("unknown root", () => expect(getPackageForPath(root, "/repo/random/file.ts")).toBe(""));
});

describe("loadFiles", () => {
  test("loads .ts files from a directory", async () => {
    const tmp = specTempDir("file-loader-test-");
    mkdirSync(join(tmp, "packages/core/src"), { recursive: true });
    writeFileSync(join(tmp, "packages/core/src/foo.ts"), "export const x = 1;\n");
    writeFileSync(join(tmp, "packages/core/src/foo.d.ts"), "declare const x: number;\n");
    writeFileSync(join(tmp, "packages/core/src/bar.spec.ts"), "test('x', () => {});\n");

    const files = await loadFiles({ repoRoot: tmp, roots: ["packages"] });
    const relPaths = [...files.values()].map((f) => f.relPath).sort();

    expect(relPaths).toContain("packages/core/src/foo.ts");
    expect(relPaths).toContain("packages/core/src/bar.spec.ts");
    expect(relPaths).not.toContain("packages/core/src/foo.d.ts");

    const foo = [...files.values()].find((f) => f.relPath === "packages/core/src/foo.ts");
    expect(foo?.isTest).toBe(false);
    expect(foo?.pkg).toBe("packages/core");

    const bar = [...files.values()].find((f) => f.relPath === "packages/core/src/bar.spec.ts");
    expect(bar?.isTest).toBe(true);
  });

  test("excludes fixture files", async () => {
    const tmp = specTempDir("file-loader-test-");
    mkdirSync(join(tmp, "scripts/rules/fixtures"), { recursive: true });
    writeFileSync(join(tmp, "scripts/rules/fixtures/test.fixture.ts"), "export const x = 1;\n");
    writeFileSync(join(tmp, "scripts/rules/real.ts"), "export const y = 2;\n");

    const files = await loadFiles({ repoRoot: tmp, roots: ["scripts"] });
    const relPaths = [...files.values()].map((f) => f.relPath);

    expect(relPaths).not.toContain("scripts/rules/fixtures/test.fixture.ts");
    expect(relPaths).toContain("scripts/rules/real.ts");
  });

  test("applies filter", async () => {
    const tmp = specTempDir("file-loader-test-");
    mkdirSync(join(tmp, "packages/core/src"), { recursive: true });
    mkdirSync(join(tmp, "packages/daemon/src"), { recursive: true });
    writeFileSync(join(tmp, "packages/core/src/a.ts"), "export const a = 1;\n");
    writeFileSync(join(tmp, "packages/daemon/src/b.ts"), "export const b = 2;\n");

    const files = await loadFiles({ repoRoot: tmp, roots: ["packages"], filter: "core" });
    const relPaths = [...files.values()].map((f) => f.relPath);

    expect(relPaths).toContain("packages/core/src/a.ts");
    expect(relPaths).not.toContain("packages/daemon/src/b.ts");
  });
});

describe("loadFiles: non-TypeScript corpora and missing roots", () => {
  function tmpRepo(): string {
    const tmp = specTempDir("file-loader-test-");
    mkdirSync(tmp, { recursive: true });
    return tmp;
  }

  test("loads .claude markdown and ignores worktrees", async () => {
    const tmp = tmpRepo();
    mkdirSync(join(tmp, ".claude/agents"), { recursive: true });
    mkdirSync(join(tmp, ".claude/worktrees/x"), { recursive: true });
    writeFileSync(join(tmp, ".claude/agents/r.md"), "# r\n");
    writeFileSync(join(tmp, ".claude/worktrees/x/skip.md"), "# no\n");

    const rel = [...(await loadFiles({ repoRoot: tmp })).values()].map((f) => f.relPath).sort();

    expect(rel).toContain(".claude/agents/r.md");
    expect(rel).not.toContain(".claude/worktrees/x/skip.md");
  });

  test("loads shell scripts, git hooks, docs and CLAUDE.md for no-process-kill, never rule fixtures", async () => {
    const tmp = tmpRepo();
    for (const d of [".claude/skills/b", "scripts/tools", "scripts/rules/fixtures", ".git-hooks", "docs", "plan"]) {
      mkdirSync(join(tmp, d), { recursive: true });
    }
    writeFileSync(join(tmp, ".claude/skills/b/merge.sh"), "#!/bin/sh\n");
    writeFileSync(join(tmp, "scripts/tools/run.sh"), "#!/bin/sh\n");
    writeFileSync(join(tmp, "README.md"), "# a\n");
    writeFileSync(join(tmp, "install.sh"), "#!/bin/sh\n");
    writeFileSync(join(tmp, "scripts/rules/fixtures/x__y.fixture.sh"), "echo fixture\n");
    writeFileSync(join(tmp, ".git-hooks/pre-push"), "#!/bin/sh\n");
    writeFileSync(join(tmp, ".git-hooks/classify.sh"), "#!/bin/sh\n");
    writeFileSync(join(tmp, "docs/guide.md"), "# d\n");
    writeFileSync(join(tmp, "CLAUDE.md"), "# c\n");
    writeFileSync(join(tmp, "plan/README.md"), "# p\n");

    const rel = [...(await loadFiles({ repoRoot: tmp })).values()].map((f) => f.relPath).sort();

    expect(rel).toEqual(
      expect.arrayContaining([
        ".claude/skills/b/merge.sh",
        ".git-hooks/classify.sh",
        ".git-hooks/pre-push",
        "CLAUDE.md",
        "README.md",
        "docs/guide.md",
        "install.sh",
        "scripts/tools/run.sh",
      ]),
    );
    expect(rel).not.toContain("scripts/rules/fixtures/x__y.fixture.sh");
    expect(rel).not.toContain("plan/README.md");
  });

  test("loads the hooks' own specs as test code, for no-git-in-tests", async () => {
    const tmp = tmpRepo();
    mkdirSync(join(tmp, ".git-hooks"), { recursive: true });
    writeFileSync(join(tmp, ".git-hooks/pre-commit.spec.ts"), "test('x', () => {});\n");
    const f = [...(await loadFiles({ repoRoot: tmp })).values()].find(
      (m) => m.relPath === ".git-hooks/pre-commit.spec.ts",
    );
    expect(f?.isTest).toBe(true);
  });

  test("TypeScript in .claude and .git-hooks is swept, and a planted raw mkdtemp there is flagged; worktrees never", async () => {
    const tmp = tmpRepo();
    for (const d of [".claude/skills/b", ".claude/worktrees/lane/scripts", ".git-hooks", "src/node_modules/x"]) {
      mkdirSync(join(tmp, d), { recursive: true });
    }
    const planted = 'import { mkdtempSync } from "node:fs";\nexport const d = mkdtempSync("x-");\n';
    writeFileSync(join(tmp, ".claude/skills/b/helper.ts"), planted);
    writeFileSync(join(tmp, ".claude/skills/b/helper.spec.ts"), planted);
    writeFileSync(join(tmp, ".claude/skills/b/types.d.ts"), "export type X = 1;\n");
    writeFileSync(join(tmp, ".git-hooks/lib.ts"), planted);
    writeFileSync(join(tmp, ".claude/worktrees/lane/scripts/other.ts"), planted);
    writeFileSync(join(tmp, ".claude/worktrees/lane/CLAUDE.md"), "# other lane\n");

    const files = await loadFiles({ repoRoot: tmp });
    const rel = [...files.values()].map((f) => f.relPath).sort();
    expect(rel).toEqual([".claude/skills/b/helper.spec.ts", ".claude/skills/b/helper.ts", ".git-hooks/lib.ts"]);

    const flagged = [...files.values()]
      .filter((f) => mkdtempRule.appliesToFile?.(f.relPath) ?? true)
      .flatMap((f) => evaluateRule(mkdtempRule, f, files).map((v) => `${f.relPath}:${v.line}`))
      .sort();
    expect(flagged).toEqual([
      ".claude/skills/b/helper.spec.ts:2",
      ".claude/skills/b/helper.ts:2",
      ".git-hooks/lib.ts:2",
    ]);
  });

  test("a narrowed `roots` keeps getting only what it asked for", async () => {
    const tmp = tmpRepo();
    mkdirSync(join(tmp, ".claude/agents"), { recursive: true });
    writeFileSync(join(tmp, ".claude/agents/r.md"), "# r\n");
    expect([...(await loadFiles({ repoRoot: tmp, roots: ["packages"] })).values()]).toEqual([]);
  });

  test("a scan root that does not exist is empty, not an error", async () => {
    const tmp = tmpRepo();
    expect([...(await loadFiles({ repoRoot: tmp })).values()]).toEqual([]);
  });
});
