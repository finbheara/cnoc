# Stages

Each `*.stage.ts` here default-exports one stage, and `bun run am-i-done` runs it with the built-in
ones. A minimal stage:

```ts
import type { Stage } from "am-i-done";

export default {
  id: "build",
  description: "The bundle builds",
  command: "bun run build",
  phase: "test", // setup | check (default) | test | report
  modes: ["default", "ci"], // absent: every mode
} satisfies Stage;
```

`bun run am-i-done --list` shows the order every stage will run in.
