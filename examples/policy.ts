// A custom placement policy: set "policy": "./policy.ts" in the server config.
// Any of order, filter and score may be given; the rest fall back to the defaults.
import type { Policy } from "../src/server/scheduler";

const policy: Partial<Policy> = {
  // Pack jobs onto the busiest host that still fits, leaving the others free for large jobs.
  score: (_job, host) => Object.values(host.reserved).reduce((a, b) => a + b, 0),
};
export default policy;
