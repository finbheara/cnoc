#!/bin/sh
# A source for `cnoc feed`: one line per open GitHub issue with a label.
#
#   feed-github-issues.sh REPO LABEL TEMPLATE [PROJECT]
#
#   REPO      owner/name, as gh takes it                   (or FEED_REPO)
#   LABEL     only issues with this label                  (or FEED_LABEL)
#   TEMPLATE  the cnoc template each issue starts          (or FEED_TEMPLATE)
#   PROJECT   passed to the template as PROJECT and used   (or FEED_PROJECT; default: the
#             in the key                                    repository name)
#   FEED_LIMIT  most issues listed, default 200
#
# Each line sets PROJECT and ISSUE and is keyed PROJECT-ISSUE, so an issue becomes one job however
# many times it is listed:
#
#   {"template":"lane","key":"myapp-1234","set":{"PROJECT":"myapp","ISSUE":"1234"}}
#
# Run it from cnoc feed, for example every five minutes:
#
#   cnoc feed --every 5m -- examples/feed-github-issues.sh example-org/myapp ready-for-agent lane
#
# Needs gh, logged in. Taking the label off an issue stops it being offered; it does not cancel a
# job that already exists.
set -eu

usage() {
  echo "usage: $0 REPO LABEL TEMPLATE [PROJECT]" >&2
  exit 2
}

FEED_REPO=${1:-${FEED_REPO:-}}
FEED_LABEL=${2:-${FEED_LABEL:-}}
FEED_TEMPLATE=${3:-${FEED_TEMPLATE:-}}
[ -n "$FEED_REPO" ] && [ -n "$FEED_LABEL" ] && [ -n "$FEED_TEMPLATE" ] || usage
FEED_PROJECT=${4:-${FEED_PROJECT:-${FEED_REPO##*/}}}
export FEED_TEMPLATE FEED_PROJECT

# The values reach jq through the environment, never spliced into the program, so a name with a
# quote in it cannot change what is printed.
exec gh issue list \
  --repo "$FEED_REPO" \
  --label "$FEED_LABEL" \
  --state open \
  --limit "${FEED_LIMIT:-200}" \
  --json number \
  --jq '.[] | {
    template: env.FEED_TEMPLATE,
    key: "\(env.FEED_PROJECT)-\(.number)",
    set: { PROJECT: env.FEED_PROJECT, ISSUE: (.number | tostring) }
  } | tojson'
