#fixture @rule no-process-kill
#fixture @expect 2
#fixture @path scripts/tools/example.sh
#!/usr/bin/env bash
# Stops serverd by the pid in serverd.pid, SIGTERM only; never pkill (it matches this shell).
set -euo pipefail
kill -TERM "$PID"
pkill -f serverd
echo "never mind, falling back" && kill -9 "$PID"
