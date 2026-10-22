# Development capture for lab #3786

Status: development evidence, not completed UAT or an end-to-end phase coverage
attestation. Public manual follow-up: https://swamp-club.com/lab/3787. UAT
acceptance is being performed manually by the requester.

## Matched local probe

On 2026-10-22, ran separate fresh local repositories with 36 workers on the same
macOS arm64 host. Each worker executed one readiness/query/small-write probe,
then another on the same worker. Both builds completed all 72 probes. Runs used
the same loopback collector, concurrency, empty initial workload history and
trace configuration; application metrics were requested in both environments
(the baseline has no application metric exporter). Logs export was disabled.
The collector listen backlog was 1024 to accept concurrent process flushes.

| Build / phase | n | p50 (s) | p95 (s) | p99 (s) | max (s) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Baseline / first use | 36 | 5.777 | 6.322 | 6.333 | 6.333 |
| Instrumented / first use | 36 | 5.851 | 6.364 | 6.381 | 6.381 |
| Baseline / reused | 36 | 5.955 | 6.530 | 6.560 | 6.560 |
| Instrumented / reused | 36 | 5.836 | 6.308 | 6.326 | 6.326 |

These are successful whole CLI probe latencies, including client startup; all
other outcome groups have n=0. They are one matched pair, not a statistically
established overhead bound. First-use p50 increased about 1.3%; reused p50 fell
about 2.0%. All probes had settled at the measurement boundary; workload pending
count was zero. This does not establish zero unfinished telemetry observations.

Instrumented raw capture: 9,907 spans. Exact matching trace and parent IDs:

- Query execution → RPC server: 72/72.
- Serve data plane → worker HTTP client: 216/216.
- Worker dispatch → serve dispatch send: 72/72.
- Serve settlement → worker execution: 72/72.

Exporter counters across process-unique resources reported 9,946 attempted,
9,907 collector-acknowledged, and 39 not-fully-acknowledged spans. The missing
39 remain loss, even though the expected probe chains were present. Collector
acknowledgment is not downstream storage evidence. Local child coverage does
not account for all step admission/preparation or cross-process intervals;
99% end-to-end time coverage has not been demonstrated.

## Reproducibility

Baseline source: `42796fc9`; binary SHA-256:
`7323428beb72f55d0d4ce7bd50565bb077d11a487b5f694bcd3dfb190029b13e`.
Instrumented development binary SHA-256:
`330923acbbf73ccf7d0c801817804b71e3e43f1fdd4cdc33db485b34eafc679b`.
Subsequent source changes require new evidence for their changed behavior.

Local evidence is retained under the session's approved temporary directory:
`fleet-3786-baseline3/results.json`, `fleet-3786-baseline3/otlp.json`,
`fleet-3786-current2/results.json`, `fleet-3786-current2/otlp.json`, and
`fleet-3786.py`. These files are local development artifacts, not published
acceptance fixtures. Earlier captures with a smaller collector backlog showed
missing parent spans and are retained separately as failed coverage evidence.
