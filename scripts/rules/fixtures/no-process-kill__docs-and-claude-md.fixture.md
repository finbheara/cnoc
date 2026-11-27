#fixture @rule no-process-kill
#fixture @expect 1
#fixture @path CLAUDE.md
# Processes

Never `pkill`, `killall` or `kill -9`. Never `pkill -f` or `pgrep -f` either: they match their own shell.

To reset, run killall Chrome.
