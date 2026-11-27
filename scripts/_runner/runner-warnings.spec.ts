import { describe, expect, it } from "bun:test";

import { StepRunner } from "./runner";
import type { Logger, Step } from "./types";

// A passing step's captured output is discarded; StepResult.warnings is how a warn-only step
// and a green-only-on-rerun still reach the person.

function makeLog(): { logger: Logger; entries: string[] } {
  const entries: string[] = [];
  const logger: Logger = {
    debug: (...a) => entries.push(`D ${a.join(" ")}`),
    info: (...a) => entries.push(`I ${a.join(" ")}`),
    warn: (...a) => entries.push(`W ${a.join(" ")}`),
    error: (...a) => entries.push(`E ${a.join(" ")}`),
  };
  return { logger, entries };
}

function warnsOnPass(name: string, warnings: string[]): Step {
  return {
    name,
    description: "x",
    command: async ({ logger }) => {
      logger.info("captured, discarded on a pass");
      return { success: true, warnings };
    },
  };
}

describe("StepRunner warnings from passing steps", () => {
  it("prints each warning as a warn line after the pass and returns them in the report", async () => {
    const { logger, entries } = makeLog();
    const report = await new StepRunner({ logger, timeoutMs: 0 })
      .add(warnsOnPass("test", ["FLAKE: first run: fail (x); re-run: pass"]), warnsOnPass("quiet", []))
      .run();
    expect(report.success).toBe(true);
    expect(report.warnings).toEqual([{ step: "test", message: "FLAKE: first run: fail (x); re-run: pass" }]);
    const pass = entries.findIndex((e) => e.startsWith("I   ✓ test"));
    const warn = entries.findIndex((e) => e === "W   ⚠ test: FLAKE: first run: fail (x); re-run: pass");
    expect(pass).toBeGreaterThanOrEqual(0);
    expect(warn).toBe(pass + 1);
    expect(entries.some((e) => e.includes("captured, discarded"))).toBe(false);
  });

  it("a run with no warnings reports an empty list", async () => {
    const { logger } = makeLog();
    const report = await new StepRunner({ logger, timeoutMs: 0 }).add(warnsOnPass("a", [])).run();
    expect(report.warnings).toEqual([]);
  });
});
