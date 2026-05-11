---
name: swamp-troubleshooting
description: >
  Diagnose swamp problems and verify health through a layered diagnostic
  loop — health checks, error inspection, tracing, and source reading. Do
  NOT use for smoke testing extensions (swamp-extension) or setting up
  repos (swamp-repo). Triggers on "swamp error", "failing", "not working",
  "crash", "timeout", "bug", "debug", "troubleshoot", "root cause", "slow",
  "performance", "latency", "erroring", "workflow error", "step error",
  "is swamp working", "health check", "diagnose swamp", "audit log empty",
  "hooks not firing", "extension not loading", "swamp-warning", "preflight",
  "doctor audit", "doctor extensions", "internals", "under the hood".
---

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

## The diagnostic loop

### Tier 1 — Health checks

For symptoms tied to a known integration (audit pipeline, extension loading).
The doctor commands name the failing piece directly and exit non-zero on
failure. Cheapest tier, fastest signal.

→ See [references/health-checks.md](references/health-checks.md).

### Tier 2 — Error inspection

For specific command failures and unexpected output. Read stderr, switch to
`--json`, check exit codes, grep for `swamp-warning:` lines. Most failures are
loud — the error surface itself usually answers the question.

→ See [references/error-inspection.md](references/error-inspection.md).

### Tier 3 — Tracing

For timing and flow questions: slow workflows, mysterious waits, "where is this
spending its time?" Enable OpenTelemetry tracing and read the span hierarchy.
Not for diagnosing errors — for understanding execution shape.

→ See [references/tracing.md](references/tracing.md).

### Tier 4 — Source reading

For questions Tiers 1–3 can't answer, and for "how does X work internally?"
questions where `swamp <command> --help` is insufficient. Fetch swamp's source
with `swamp source fetch` and read the implementation. Most expensive tier —
reach for it last.

→ See [references/source-reading.md](references/source-reading.md).

## Symptom → tier index

| Symptom                                                  | Start at                                                  |
| -------------------------------------------------------- | --------------------------------------------------------- |
| Audit log empty / hooks not firing                       | Tier 1 → `swamp doctor audit`                             |
| Extension model/vault/driver/datastore/report not loaded | Tier 1 → `swamp doctor extensions`                        |
| `swamp-warning:` line on stderr                          | Tier 1 → `swamp doctor extensions`                        |
| CI preflight needs to gate on integration health         | Tier 1 → either doctor with `--json`                      |
| Command errored — message is clear                       | Tier 2 → read it, fix the named issue                     |
| Command errored — message is vague or unhelpful          | Tier 2 → re-run with `--json`, then escalate              |
| Item "not found" / "not in search results"               | Tier 2 → check stderr for `swamp-warning:`                |
| Method failed `Pre-flight check failed: …`               | Tier 2 → see [references/checks.md](references/checks.md) |
| Workflow / method / sync is slow                         | Tier 3 → enable tracing                                   |
| "Where is this spending its time?"                       | Tier 3 → enable tracing                                   |
| Need to understand internal behavior of a command        | Tier 4 → fetch source                                     |
| Tier-1-clean integration that still misbehaves           | Tier 4 → fetch source                                     |

## Diagnostic playbook

For a typical investigation:

1. Match the symptom against the index above. If a tier is named, jump there.
2. If no tier matches, run Tier 2 (error inspection) — read stderr and switch to
   `--json` first.
3. Capture what each tier ruled out before escalating, so the next tier has
   context.
4. Once the root cause is identified, state it clearly, suggest a fix or
   workaround, and (if it's a bug) summarize for an issue report.

## When to use other skills

| Need                                  | Use Skill                                                         |
| ------------------------------------- | ----------------------------------------------------------------- |
| Run/create models                     | `swamp-model`                                                     |
| Run/create workflows                  | `swamp-workflow`                                                  |
| Manage secrets                        | `swamp-vault`                                                     |
| Manage repository / install / upgrade | `swamp-repo`                                                      |
| Author custom extensions              | `swamp-extension`                                                 |
| Debug method preflight checks         | this skill, Tier 2 + [references/checks.md](references/checks.md) |

## References

- [references/health-checks.md](references/health-checks.md) — Tier 1: doctor
  commands (`swamp doctor audit`, `swamp doctor extensions`), exit codes, CI
  usage.
- [references/error-inspection.md](references/error-inspection.md) — Tier 2:
  stderr habits, `--json` switching, `swamp-warning:` lines, recipes for
  "extension not appearing" and "source extension not loading."
- [references/tracing.md](references/tracing.md) — Tier 3: OpenTelemetry setup,
  span hierarchy, diagnosing slow workflows / GC / sync.
- [references/source-reading.md](references/source-reading.md) — Tier 4:
  `swamp source fetch/path/clean`, source layout, where to look by symptom.
- [references/checks.md](references/checks.md) — Per-method preflight check
  troubleshooting (skip flags, check selection errors, conflicts) — separate
  concept from Tier 1 doctor commands.
