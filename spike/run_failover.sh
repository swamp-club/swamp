#!/usr/bin/env bash
# Runs exp_failover.ts across targets; writes JSON lines to results/.
set -u
out=results/failover-$(uname -s | tr A-Z a-z)-$(uname -m).jsonl
: > "$out"
for t in "file 1,100,1000" "s3:45934 1,100,1000" "s3:45937 1,100"; do
  set -- $t
  NO_COLOR=1 deno run -A exp_failover.ts "$1" "$2" 2> "../../fo-${1%%:*}-${1##*:}.err" | grep '^{' >> "$out"
done
