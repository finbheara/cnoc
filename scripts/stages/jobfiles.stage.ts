import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Stage } from "am-i-done";
import { checkTemplate, isTemplate, parseJob } from "../../src/jobfile";

/** Every example Jobfile and template parses, with the parser the server and the CLI use. */
export default {
  id: "jobfiles",
  description: "Every example Jobfile and template parses (examples/*.job)",
  command: async ({ root }) => {
    const files = [...new Bun.Glob("examples/*.job").scanSync({ cwd: root })].sort();
    // An empty directory would otherwise pass by checking nothing.
    if (files.length === 0) return { success: false, error: "no examples/*.job found" };
    const problems: string[] = [];
    for (const rel of files) {
      const text = readFileSync(join(root, rel), "utf8");
      try {
        if (isTemplate(text)) checkTemplate(text);
        else parseJob(text);
      } catch (e) {
        problems.push(`${rel}: ${(e as Error).message}`);
      }
    }
    if (problems.length === 0) return true;
    return {
      success: false,
      error: `${problems.length} of ${files.length} examples do not parse`,
      output: problems.join("\n"),
    };
  },
  onFailure: [
    "an example no longer matches the Jobfile syntax: fix the example, or the parser if the syntax was meant to hold",
    "check one by hand: bun src/cli.ts check examples/NAME.job",
  ],
} satisfies Stage;
