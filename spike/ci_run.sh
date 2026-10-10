#!/usr/bin/env bash
# CI entry point for the spike job: runs the platform probe and reduced
# experiments against the file replica, printing JSON lines.
set -u
cd "$(dirname "$0")"
run() { echo "## $*"; deno run -A "$@" 2> >(grep -E "ERROR|panic" | head -5 >&2) | grep '^{' || echo '{"failed":"'"$1"'"}'; }
run platform_probe.ts
run exp_compat.ts passive-default 5000
run exp_compat.ts app-truncate 5000
run exp_latency.ts file 10
run exp_crash.ts 10 file
run exp_failover.ts file 1,100
