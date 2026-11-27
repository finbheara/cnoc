#!/bin/sh
# A source for `cnoc feed`: one line per open GitHub issue with a label, oldest first.
#
#   feed-github-issues.sh REPO LABEL TEMPLATE [PROJECT]
#
#   REPO        owner/name, as gh takes it                      (or FEED_REPO)
#   LABEL       only issues with this label; it must exist      (or FEED_LABEL)
#   TEMPLATE    the cnoc template each issue starts             (or FEED_TEMPLATE)
#   PROJECT     passed to the template as PROJECT and used in   (or FEED_PROJECT; default: the
#               the key, as given                                repository name, lower-cased)
#   FEED_LIMIT  most issues listed, 1 to 999, default 200. More open issues with the label than
#               this is an error, not a quiet cut: raise the limit or narrow the label.
#
# Each line sets PROJECT and ISSUE and is keyed PROJECT-ISSUE, so an issue becomes one job however
# many times it is listed:
#
#   {"template":"lane","key":"myapp-1234","set":{"PROJECT":"myapp","ISSUE":"1234"}}
#
# The key is never the bare issue number: cnoc refuses an all-digit key, because <template>/<n> is
# the name of an unkeyed, numbered run. The key is the identity of the item: changing PROJECT (or
# the template's name) changes every key, and the whole labelled backlog is offered again as new.
#
# Issues are listed oldest first, so with `cnoc feed --max` the oldest are started first and a
# burst of new issues cannot starve them.
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
FEED_PROJECT=${4:-${FEED_PROJECT:-$(printf '%s' "${FEED_REPO##*/}" | tr '[:upper:]' '[:lower:]')}}
limit=${FEED_LIMIT:-200}
# GitHub's search returns at most 1000 results, so one more than the limit must fit in that.
case $limit in '' | *[!0-9]*) echo "$0: FEED_LIMIT must be a whole number, got $limit" >&2 && exit 2 ;; esac
if [ "$limit" -lt 1 ] || [ "$limit" -gt 999 ]; then
  echo "$0: FEED_LIMIT must be from 1 to 999 (GitHub search returns at most 1000), got $limit" >&2
  exit 2
fi
export FEED_TEMPLATE FEED_PROJECT FEED_LABEL

# A label that does not exist lists nothing, which would look like an empty backlog forever.
# Values reach jq through the environment, never spliced into the program.
found=$(gh label list --repo "$FEED_REPO" --limit 1000 --json name \
  --jq '[.[] | select((.name | ascii_downcase) == (env.FEED_LABEL | ascii_downcase))] | length')
if [ "$found" = 0 ]; then
  echo "$0: $FEED_REPO has no label \"$FEED_LABEL\"" >&2
  exit 1
fi

# One more than the limit is asked for, so a backlog bigger than the limit is seen as such.
lines=$(gh issue list \
  --repo "$FEED_REPO" \
  --label "$FEED_LABEL" \
  --state open \
  --search "sort:created-asc" \
  --limit "$((limit + 1))" \
  --json number \
  --jq '.[] | {
    template: env.FEED_TEMPLATE,
    key: "\(env.FEED_PROJECT)-\(.number)",
    set: { PROJECT: env.FEED_PROJECT, ISSUE: (.number | tostring) }
  } | tojson')
count=$(printf '%s' "$lines" | grep -c . || true)
if [ "$count" -gt "$limit" ]; then
  echo "$0: more than $limit open issues labelled \"$FEED_LABEL\" in $FEED_REPO; raise FEED_LIMIT" >&2
  exit 1
fi
[ -z "$lines" ] || printf '%s\n' "$lines"
