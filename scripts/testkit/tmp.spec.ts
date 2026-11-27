import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { SPEC_TMP_PREFIX, reapDeadSpecTempRoots, specTempDir, specTempRoot, tmpDir, tmpScope } from "./tmp";

describe("specTempDir", () => {
  test("lands under this run's pid-named root", () => {
    const d = specTempDir("tk-spec-");
    expect(existsSync(d)).toBe(true);
    expect(dirname(d)).toBe(specTempRoot());
    expect(basename(dirname(d))).toBe(`${SPEC_TMP_PREFIX}${process.pid}`);
    expect(basename(d).startsWith("tk-spec-")).toBe(true);
  });
});

describe("tmpScope / tmpDir", () => {
  test("a scope removes every directory it made when the block returns", () => {
    let made: string[] = [];
    {
      using fx = tmpScope();
      made = [fx.dir("a-"), fx.dir("b-")];
      writeFileSync(join(made[0] as string, "f"), "x");
      expect(made.every((d) => existsSync(d))).toBe(true);
    }
    expect(made.some((d) => existsSync(d))).toBe(false);
  });

  test("a scope removes its directories when the block throws, and runs deferred steps first", () => {
    let made = "";
    const order: string[] = [];
    expect(() => {
      using fx = tmpScope();
      made = fx.dir("throws-");
      fx.defer(() => order.push(existsSync(made) ? "deferred-while-present" : "deferred-after"));
      throw new Error("boom");
    }).toThrow("boom");
    expect(existsSync(made)).toBe(false);
    expect(order).toEqual(["deferred-while-present"]);
  });

  test("a disposed scope refuses further use", () => {
    const fx = tmpScope();
    fx[Symbol.dispose]();
    expect(() => fx.dir("late-")).toThrow("used after disposal");
  });

  test("tmpDir is one directory with the same lifetime", () => {
    let path = "";
    {
      using d = tmpDir("one-");
      path = d.path;
      expect(existsSync(path)).toBe(true);
    }
    expect(existsSync(path)).toBe(false);
  });
});

describe("TmpScope ownership", () => {
  test("an adopted path is removed with the scope, and owned lists everything in creation order", () => {
    const outside = specTempDir("tk-adopt-");
    let owned: readonly string[] = [];
    {
      using fx = tmpScope();
      const made = fx.dir("tk-own-");
      expect(fx.adopt(outside)).toBe(outside);
      owned = [...fx.owned];
      expect(owned).toEqual([made, outside]);
    }
    expect(owned.map(existsSync)).toEqual([false, false]);
  });

  test("every step runs even when one throws, and the first error is re-thrown", () => {
    const order: string[] = [];
    const fx = tmpScope();
    const d = fx.dir("tk-throw-");
    fx.defer(() => order.push("second"));
    fx.defer(() => {
      order.push("first");
      throw new Error("deferred failed");
    });
    expect(() => fx[Symbol.dispose]()).toThrow("deferred failed");
    expect({ order, removed: !existsSync(d) }).toEqual({ order: ["first", "second"], removed: true });
    expect(() => fx[Symbol.dispose]()).not.toThrow();
  });
});

describe("reapDeadSpecTempRoots", () => {
  test("removes only prefix+pid roots whose pid is dead; keeps live, own, and look-alike names", () => {
    using fx = tmpScope();
    const base = fx.dir("reap-base-");
    const names = [
      `${SPEC_TMP_PREFIX}111`, // dead
      `${SPEC_TMP_PREFIX}222`, // alive
      `${SPEC_TMP_PREFIX}${process.pid}`, // this process
      `${SPEC_TMP_PREFIX}abc`, // not a pid
      `${SPEC_TMP_PREFIX}333-x`, // not exactly a pid
      "unrelated-111",
    ];
    for (const n of names) mkdirSync(join(base, n));
    const reaped = reapDeadSpecTempRoots(base, (pid) => pid === 222);
    expect(reaped).toEqual([join(base, `${SPEC_TMP_PREFIX}111`)]);
    const left = names.filter((n) => existsSync(join(base, n)));
    expect(left).toEqual(names.slice(1));
  });

  test("a missing base is nothing to reap", () => {
    expect(reapDeadSpecTempRoots("/nonexistent/cnoc-tk")).toEqual([]);
  });
});
