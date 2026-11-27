/**
 * install.sh re-run on an existing install, in a sandboxed HOME against a local origin, with
 * --no-service so no service manager is touched. Nothing reaches the network.
 */
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { specTempDir } from "../scripts/testkit";
import { LEGACY_UPDATE } from "../src/client/update";
import { git, makeRepos } from "./git-fixture";

const INSTALL = join(import.meta.dir, "..", "install.sh");

test("install.sh's copy of the legacy update pattern is the client's", () => {
  const m = /^LEGACY_UPDATE_SOURCE='(.*)'$/m.exec(readFileSync(INSTALL, "utf8"));
  expect(m?.[1]).toBe(LEGACY_UPDATE.source);
  expect(LEGACY_UPDATE.flags).toBe("");
});

test("re-running install.sh with a --ref older than the client's update code still cleans the config", async () => {
  const root = specTempDir("cnoc-install-");
  // The fixture's commits have no src/client/update.ts, as code from before it had none.
  const { origin, commits } = makeRepos(join(root, "repos"), 2);
  git(origin, "tag", "old", commits[0] as string);
  const home = join(root, "home");
  const app = join(home, ".local", "share", "cnoc", "app");
  mkdirSync(dirname(app), { recursive: true });
  git(root, "clone", "-q", origin, app);
  const config = join(home, ".config", "cnoc", "client.json");
  mkdirSync(dirname(config), { recursive: true });
  const legacy = `git -C '${app}' pull -q --ff-only && 'bun' install --cwd '${app}' --frozen-lockfile --production`;
  writeFileSync(
    config,
    JSON.stringify({ server: "http://127.0.0.1:1", name: "sandbox", projects: {}, update: legacy }),
  );

  const p = Bun.spawn(["bash", INSTALL, "--ref", "old", "--no-service"], {
    env: { HOME: home, CNOC_REPO: origin, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  expect({ code, err: err.includes("Cannot find module") ? err : "" }).toEqual({ code: 0, err: "" });
  expect(out).toContain("removed the old update command");
  expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({
    server: "http://127.0.0.1:1",
    name: "sandbox",
    projects: {},
  });
  expect(git(app, "rev-parse", "HEAD")).toBe(commits[0] as string);
});
