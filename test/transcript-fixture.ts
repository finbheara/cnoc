/**
 * Synthetic Claude Code transcripts, shaped like the real ones: one line per content block, each
 * line of a response repeating its usage under one `message.id`, early blocks sometimes with a
 * smaller `output_tokens`. Every value here is made up.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Counts {
  input: number;
  output: number;
  cache_creation: number;
  cache_read: number;
}

/** One transcript line of an assistant response. */
export function assistant(id: string, model: string, n: Counts, stop: string | null = "end_turn"): string {
  return JSON.stringify({
    type: "assistant",
    uuid: `u-${id}-${Math.random().toString(36).slice(2)}`,
    sessionId: "s",
    requestId: `req-${id}`,
    message: {
      id,
      model,
      role: "assistant",
      type: "message",
      stop_reason: stop,
      content: [{ type: "text", text: "synthetic" }],
      usage: {
        input_tokens: n.input,
        output_tokens: n.output,
        cache_creation_input_tokens: n.cache_creation,
        cache_read_input_tokens: n.cache_read,
        service_tier: "standard",
      },
    },
  });
}

export const user = (text: string): string =>
  JSON.stringify({ type: "user", message: { role: "user", content: text } });

export const c = (input: number, output: number, cache_creation = 0, cache_read = 0): Counts => ({
  input,
  output,
  cache_creation,
  cache_read,
});

/**
 * Writes `<config>/projects/<dir>/<session>.jsonl` and, for each entry of `subagents`, a file
 * under `<session>/subagents/`. Returns the main transcript's path.
 */
export function writeTranscript(
  config: string,
  session: string,
  main: string[],
  subagents: Record<string, string[]> = {},
  dir = "-work-myapp",
): string {
  const base = join(config, "projects", dir);
  mkdirSync(base, { recursive: true });
  const file = join(base, `${session}.jsonl`);
  writeFileSync(file, `${main.join("\n")}\n`);
  for (const [rel, lines] of Object.entries(subagents)) {
    const p = join(base, session, "subagents", rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, `${lines.join("\n")}\n`);
  }
  return file;
}

/** A small session: two responses on the main model, one subagent response on another. */
export function standardSession(config: string, session: string): string {
  return writeTranscript(
    config,
    session,
    [
      user("do the thing"),
      assistant("msg_1", "claude-opus-test", c(10, 2, 100, 0), null),
      assistant("msg_1", "claude-opus-test", c(10, 20, 100, 0), "tool_use"),
      user("tool result"),
      assistant("msg_2", "claude-opus-test", c(5, 30, 0, 100)),
    ],
    { "agent-a1.jsonl": [assistant("msg_3", "claude-sonnet-test", c(1, 7, 3, 4))] },
  );
}
/** What `standardSession` adds up to. */
export const STANDARD_TOTAL: Counts = { input: 16, output: 57, cache_creation: 103, cache_read: 104 };
