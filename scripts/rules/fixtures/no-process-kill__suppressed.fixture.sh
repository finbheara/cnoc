#fixture @rule no-process-kill
#fixture @expect 0
#fixture @path scripts/example.sh
#!/usr/bin/env bash
# // dotw-ignore no-process-kill: a reasoned, reviewed exception
pkill -x example-only-this-name
