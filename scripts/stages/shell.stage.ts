import type { Stage } from "am-i-done";

/** Not optional: a machine without shellcheck fails here, and the message says how to install it. */
export default {
  id: "shell",
  description: "shellcheck over install.sh, the example feed source and the git hooks",
  command: [
    "shellcheck",
    "install.sh",
    "examples/feed-github-issues.sh",
    ".git-hooks/pre-commit",
    ".git-hooks/pre-push",
  ],
  onFailure: [
    "`shellcheck` not found: install it (brew install shellcheck, apt install shellcheck); the stage is not optional",
    "otherwise fix what shellcheck reports; disable a finding only with a comment that says why",
  ],
} satisfies Stage;
