#!/usr/bin/env bash
# Installs the cnoc client on this host and runs it as a user service.
#
#   curl -fsSL https://raw.githubusercontent.com/finbheara/cnoc/main/install.sh | bash -s -- \
#     --server http://controller.example:7878 --project myapp=~/github/myapp
#
# Safe to run again: it updates the code, rewrites the service and keeps the existing config.
set -euo pipefail

usage() {
  cat <<'EOF'
cnoc client installer

  install.sh --server URL [options]
  install.sh --uninstall

  --server URL          the cnoc server, such as http://controller.example:7878
  --name NAME           this host's name on the server (default: short hostname)
  --project NAME=PATH   a project this host has checked out; repeat for more
  --resource NAME=N     a resource this host offers; repeat for more (default: slots=1)
  --ref REF             branch or tag of cnoc to install (default: main)
  --force               overwrite an existing client config
  --no-service          install only; do not create or start a service
  --uninstall           stop the service and remove the code; config and host key are kept
EOF
}

say() { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

REPO=${CNOC_REPO:-https://github.com/finbheara/cnoc}
APP=$HOME/.local/share/cnoc/app
BIN=$HOME/.local/bin
CONFIG=$HOME/.config/cnoc/client.json
ENVFILE=$HOME/.config/cnoc/client.env
STATE=$HOME/.local/state/cnoc
UNIT=$HOME/.config/systemd/user/cnoc-client.service
PLIST=$HOME/Library/LaunchAgents/cnoc.client.plist
LABEL=cnoc.client
LOG=$HOME/Library/Logs/cnoc-client.log

have_systemd() { [ "$(uname -s)" = Linux ] && systemctl --user show-environment >/dev/null 2>&1; }
have_launchd() { [ "$(uname -s)" = Darwin ] && command -v launchctl >/dev/null 2>&1; }

# The service does not read shell profiles, so it gets the PATH the installer saw.
# Entries with characters a unit file or plist would need escaped are left out.
service_path() {
  local out="" entry seen=":"
  local IFS=:
  for entry in $1; do
    [ -n "$entry" ] || continue
    case "$entry" in *[!A-Za-z0-9_./+@-]*) continue ;; esac
    case "$seen" in *":$entry:"*) continue ;; esac
    seen="$seen$entry:"
    out="${out:+$out:}$entry"
  done
  printf '%s' "$out"
}

stop_service() {
  if have_systemd && [ -f "$UNIT" ]; then
    systemctl --user disable --now cnoc-client.service >/dev/null 2>&1 || true
  fi
  if have_launchd; then
    launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  fi
}

uninstall() {
  say "stopping the service"
  stop_service
  rm -f "$UNIT" "$PLIST" "$BIN/cnoc"
  if have_systemd; then systemctl --user daemon-reload || true; fi
  rm -rf "$APP"
  say "removed. Kept: $CONFIG and the host key in $STATE"
  say "sessions that were running are still in tmux: tmux -L cnoc ls"
}

main() {
  local server="" name="" ref="main" force=0 service=1
  local projects=() resources=()

  while [ $# -gt 0 ]; do
    case "$1" in
      --server) server=${2:?--server needs a URL}; shift 2 ;;
      --name) name=${2:?--name needs a value}; shift 2 ;;
      --project) projects+=("${2:?--project needs NAME=PATH}"); shift 2 ;;
      --resource) resources+=("${2:?--resource needs NAME=N}"); shift 2 ;;
      --ref) ref=${2:?--ref needs a value}; shift 2 ;;
      --force) force=1; shift ;;
      --no-service) service=0; shift ;;
      --uninstall) uninstall; exit 0 ;;
      -h | --help) usage; exit 0 ;;
      *) usage >&2; die "unknown option: $1" ;;
    esac
  done

  # Prerequisites.
  command -v git >/dev/null 2>&1 || die "git is required"
  command -v tmux >/dev/null 2>&1 || die "tmux is required"
  local bun
  bun=$(command -v bun 2>/dev/null || true)
  if [ -z "$bun" ] && [ -x "$HOME/.bun/bin/bun" ]; then bun=$HOME/.bun/bin/bun; fi
  [ -n "$bun" ] || die "Bun is required. Install it with: curl -fsSL https://bun.sh/install | bash"

  if [ ! -f "$CONFIG" ] || [ "$force" = 1 ]; then
    [ -n "$server" ] || die "--server URL is required for a first install (see --help)"
  elif [ -n "$server$name" ] || [ ${#projects[@]} -gt 0 ] || [ ${#resources[@]} -gt 0 ]; then
    warn "$CONFIG exists and is kept as it is; pass --force to rewrite it from these options"
  fi

  # Code.
  if [ -d "$APP/.git" ]; then
    say "updating $APP"
    git -C "$APP" fetch -q origin
    git -C "$APP" checkout -q "$ref"
    git -C "$APP" pull -q --ff-only 2>/dev/null || true # a tag has nothing to pull
  else
    say "installing cnoc ($ref) to $APP"
    mkdir -p "$(dirname "$APP")"
    git clone -q --branch "$ref" "$REPO" "$APP"
  fi
  "$bun" install --cwd "$APP" --frozen-lockfile --production >/dev/null

  # Command.
  mkdir -p "$BIN"
  printf '#!/bin/sh\nexec "%s" "%s/src/cli.ts" "$@"\n' "$bun" "$APP" >"$BIN/cnoc"
  chmod +x "$BIN/cnoc"
  case ":$PATH:" in *":$BIN:"*) ;; *) warn "$BIN is not on your PATH; add it to use the cnoc command" ;; esac

  # Config.
  if [ ! -f "$CONFIG" ] || [ "$force" = 1 ]; then
    [ -n "$name" ] || name=$(hostname -s 2>/dev/null || hostname)
    name=$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')
    [ ${#resources[@]} -gt 0 ] || resources=("slots=1")
    mkdir -p "$(dirname "$CONFIG")"
    # shellcheck disable=SC2016
    CNOC_I_SERVER=$server CNOC_I_NAME=$name CNOC_I_OUT=$CONFIG \
      CNOC_I_PROJECTS=$(printf '%s\n' ${projects[@]+"${projects[@]}"}) \
      CNOC_I_RESOURCES=$(printf '%s\n' "${resources[@]}") \
      "$bun" -e '
        const { existsSync, writeFileSync } = require("node:fs");
        const pairs = (s) => (s || "").split("\n").filter(Boolean).map((l) => {
          const i = l.indexOf("=");
          if (i < 1 || i === l.length - 1) { console.error(`error: expected NAME=VALUE, got "${l}"`); process.exit(1); }
          return [l.slice(0, i), l.slice(i + 1)];
        });
        const e = process.env;
        const home = (p) => (p.startsWith("~/") ? e.HOME + p.slice(1) : p);
        const projects = Object.fromEntries(pairs(e.CNOC_I_PROJECTS));
        for (const [n, p] of Object.entries(projects)) if (!existsSync(home(p))) console.error(`warning: project ${n}: ${p} does not exist on this host`);
        const resources = Object.fromEntries(pairs(e.CNOC_I_RESOURCES).map(([n, v]) => {
          if (!/^\d+$/.test(v)) { console.error(`error: resource ${n}: "${v}" is not a count`); process.exit(1); }
          return [n, Number(v)];
        }));
        writeFileSync(e.CNOC_I_OUT, JSON.stringify({ server: e.CNOC_I_SERVER, name: e.CNOC_I_NAME, projects, resources }, null, 2) + "\n");
      '
    say "wrote $CONFIG"
  else
    name=$("$bun" -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).name ?? "")' "$CONFIG")
    # Older installers wrote an "update" command that pulls a branch; the client now updates itself
    # to the server's exact commit and ignores that command, so it is removed to avoid confusion.
    "$bun" -e '
      const fs = require("node:fs");
      const f = process.argv[1];
      const cfg = JSON.parse(fs.readFileSync(f, "utf8"));
      if (/^git -C .* pull -q --ff-only && .* install --cwd .* --frozen-lockfile --production$/.test(cfg.update ?? "")) {
        delete cfg.update;
        fs.writeFileSync(f, JSON.stringify(cfg, null, 2) + "\n");
        console.log("==> removed the old update command from " + f);
      }
    ' "$CONFIG"
    say "kept $CONFIG"
  fi

  # Service.
  local path
  path=$(service_path "$(dirname "$bun"):$BIN:$PATH")
  if [ "$service" = 0 ]; then
    say "no service installed. Start the client with: cnoc client"
  elif have_systemd; then
    mkdir -p "$(dirname "$UNIT")"
    cat >"$UNIT" <<EOF
[Unit]
Description=cnoc client ($REPO)

[Service]
ExecStart=$bun $APP/src/cli.ts client --config $CONFIG --state $STATE
Environment=PATH=$path
EnvironmentFile=-$ENVFILE
Restart=always
RestartSec=10
# Sessions live in tmux and must outlive a client restart or upgrade.
KillMode=process

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable -q cnoc-client.service
    systemctl --user restart cnoc-client.service
    if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" != yes ]; then
      loginctl enable-linger "$(id -un)" >/dev/null 2>&1 ||
        warn "could not enable lingering; the client will stop when you log out. As root: loginctl enable-linger $(id -un)"
    fi
    say "service started: systemctl --user status cnoc-client   (logs: journalctl --user -u cnoc-client -f)"
  elif have_launchd; then
    mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
    cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$bun</string><string>$APP/src/cli.ts</string><string>client</string>
    <string>--config</string><string>$CONFIG</string>
    <string>--state</string><string>$STATE</string>
  </array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$path</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
    launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    say "service started: launchctl print gui/$(id -u)/$LABEL   (logs: $LOG)"
  else
    warn "no systemd user session or launchd found; start the client yourself with: cnoc client"
  fi

  say "done. If this host is new to the server, approve it there once:  cnoc hosts approve $name"
}

main "$@"
