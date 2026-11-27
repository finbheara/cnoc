/**
 * tmux on a dedicated server socket, so Cnoc sessions never mix with a person's own.
 * Sessions belong to the tmux server, not to the client process: they survive a client
 * restart or upgrade and are picked up again by name.
 */

export type PaneStatus = { state: "running" } | { state: "dead"; exit: number } | { state: "gone" };

export class Tmux {
  constructor(readonly socket: string) {}

  private async run(args: string[], env?: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
    const p = Bun.spawn(["tmux", "-L", this.socket, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: env ? { ...process.env, ...env } : process.env,
    });
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    return { code, out, err };
  }

  async newSession(name: string, cwd: string, env: Record<string, string>, cmd: string): Promise<void> {
    const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    // remain-on-exit keeps a finished pane around long enough to read its exit status and scrollback.
    // tmux gives a new session's first process the PATH of the tmux command that created it,
    // ignoring -e, so the job's PATH has to be set on that command too.
    const r = await this.run(
      [
        // /bin/sh keeps a person's shell profile from rewriting the environment the job was given.
        "set-option",
        "-g",
        "default-shell",
        "/bin/sh",
        ";",
        "set-option",
        "-g",
        "remain-on-exit",
        "on",
        ";",
        "set-option",
        "-g",
        "history-limit",
        "50000",
        ";",
        "new-session",
        "-d",
        "-s",
        name,
        "-x",
        "220",
        "-y",
        "50",
        "-c",
        cwd,
        ...envArgs,
        cmd,
      ],
      env.PATH ? { PATH: env.PATH } : undefined,
    );
    if (r.code !== 0) throw new Error(`tmux new-session failed: ${r.err.trim() || r.out.trim()}`);
  }

  async status(name: string): Promise<PaneStatus> {
    const r = await this.run(["display-message", "-p", "-t", `=${name}:`, "#{pane_dead}:#{pane_dead_status}"]);
    if (r.code !== 0) return { state: "gone" };
    const [dead, exit] = r.out.trim().split(":");
    return dead === "1" ? { state: "dead", exit: Number(exit ?? 0) || 0 } : { state: "running" };
  }

  async capture(name: string, history = false): Promise<string> {
    const r = await this.run(["capture-pane", "-p", "-J", "-t", `=${name}:`, ...(history ? ["-S", "-"] : [])]);
    return r.code === 0 ? r.out : "";
  }

  /** Short single-line text is typed; anything else is pasted so newlines do not submit early. */
  async sendText(name: string, text: string): Promise<void> {
    if (!text.includes("\n") && text.length <= 200) {
      await this.run(["send-keys", "-t", `=${name}:`, "-l", "--", text]);
      return;
    }
    const buffer = `cnoc-${name}`;
    await this.run(["set-buffer", "-b", buffer, "--", text]);
    await this.run(["paste-buffer", "-p", "-d", "-b", buffer, "-t", `=${name}:`]);
  }

  async sendKey(name: string, key: string): Promise<void> {
    await this.run(["send-keys", "-t", `=${name}:`, key]);
  }

  async kill(name: string): Promise<void> {
    await this.run(["kill-session", "-t", `=${name}`]);
  }

  async sessions(): Promise<string[]> {
    const r = await this.run(["list-sessions", "-F", "#{session_name}"]);
    return r.code === 0 ? r.out.split("\n").filter(Boolean) : [];
  }

  async killServer(): Promise<void> {
    await this.run(["kill-server"]);
  }
}
