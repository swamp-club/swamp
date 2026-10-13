#!/usr/bin/env bash
# CI entry point for the spike job: runs the platform probe and reduced
# experiments against the file replica, printing JSON lines.
set -u
cd "$(dirname "$0")"
err="${RUNNER_TEMP:-/tmp}/spike-stderr.log"
run() {
  echo "## $*"
  if ! NO_COLOR=1 deno run -A "$@" 2> "$err" | grep '^{'; then
    echo '{"failed":"'"$1"'"}'
    tail -20 "$err" >&2
  fi
  grep -E "level=ERROR|panic" "$err" | sed 's/time=[^ ]* //' | sort | uniq -c | head -5 >&2 || true
}
if [ "${OS:-}" = "Windows_NT" ]; then run win_diag.ts; fi
run platform_probe.ts
run exp_compat.ts passive-default 5000
run exp_compat.ts app-truncate 5000
run exp_latency.ts file 10
run exp_crash.ts 10 file
run exp_failover.ts file 1,100
