# Swamp Troubleshooting

Diagnose swamp problems by working through four diagnostic tiers, cheapest
first. Each tier answers a different kind of question; escalate only when the
current tier doesn't resolve the issue.

**Verify CLI syntax:** If unsure about exact flags or subcommands, run
`swamp help <command>` for the up-to-date schema. Every swamp command supports
both `log` (default, human-readable) and `--json` (structured) output, and
returns non-zero on user-facing failure.

## Diagnostic mindset

- **Start cheap, escalate.** Don't fetch source when a doctor command would name
  the problem in seconds.
- **Read what's already on screen.** Stderr, exit codes, and `--json` output
  carry most of the answer.
- **Don't skip tiers.** Tracing without first reading the error is guessing;
  fetching source without trying `--json` is overkill.
- **One symptom, one tier.** If a symptom matches the table below, jump directly
  to that tier — don't run the loop top to bottom.

## The Four Tiers

| Tier                | When to use                                  | Key tool                                        |
| ------------------- | -------------------------------------------- | ----------------------------------------------- |
| 1. Health checks    | Known integration issues (extensions, audit) | `swamp doctor extensions`, `swamp doctor audit` |
| 2. Error inspection | Command failures, unexpected output          | stderr, `--json`, exit codes                    |
| 3. Tracing          | Slow workflows, timing questions             | OpenTelemetry spans                             |
| 4. Source reading   | Internal behavior questions                  | `swamp source fetch`                            |

## Symptom → tier index

| Symptom                                           | Start at                              |
| ------------------------------------------------- | ------------------------------------- |
| Extension not loaded / `swamp-warning:` on stderr | Tier 1 → `swamp doctor extensions`    |
| Command errored — message is clear                | Tier 2 → read it, fix the named issue |
| Command errored — message is vague                | Tier 2 → re-run with `--json`         |
| Workflow / method / sync is slow                  | Tier 3 → enable tracing               |
| Need to understand internal behavior              | Tier 4 → fetch source                 |

For detailed walkthroughs of each tier, see [reference.md](reference.md).
