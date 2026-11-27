/**
 * @rule no-process-kill
 * @expect 3
 * @path scripts/example.ts
 *
 * In code the warn exemption applies only inside a comment: a spawned `pkill` and a `kill -9` in a
 * string are flagged even when the string says "never", and a comment that INSTRUCTS is flagged.
 * The two warning comments pass.
 */
import { spawnSync } from "node:child_process";

// Never `pkill -f`: it matches its own shell.
/** Stop only our own pid with SIGTERM, never with `kill -9`. */
export function stop(pid: number): void {
  spawnSync("pkill", ["-f", "serverd"]);
  spawnSync("sh", ["-c", `kill -9 ${pid} # never do this`]);
  // then killall the rest
}
