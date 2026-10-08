# Swamp Troubleshooting

Diagnose swamp problems by working through four diagnostic tiers, cheapest
first. Each tier answers a different kind of question; escalate only when the
current tier doesn't resolve the issue.

**Verify CLI syntax:** Always run `swamp help <command>` to confirm exact flags
before executing — the output is structured JSON. Every swamp command supports
both `log` (default, human-readable) and `--json` (structured) output, and
returns non-zero on user-facing failure.

## Before you start: version-drift check

Before entering the diagnostic tiers, check whether the swamp binary or any
installed extensions are out of date. A stale version is a common root cause —
the fix may already exist in a newer release, and the check takes seconds.

```bash
swamp update --check          # is the swamp binary up to date?
swamp extension outdated      # are any extensions behind their latest version?
```

- If either reports an update is available, run `swamp update` and/or
  `swamp extension pull <name>` to get the latest, then retry the failing
  operation before continuing.
- If both report up to date (or the commands fail), proceed to the diagnostic
  tiers below.

For the full procedure (JSON output interpretation, what to do when updates are
found), see [references/version-check.md](references/version-check.md).

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

| Tier                | When to use                          | Key tool                                      |
| ------------------- | ------------------------------------ | --------------------------------------------- |
| 1. Health checks    | Known integration issues, stale runs | `swamp doctor extensions`, `swamp run doctor` |
| 2. Error inspection | Command failures, unexpected output  | stderr, `--json`, exit codes                  |
| 3. Tracing          | Slow workflows, timing questions     | OpenTelemetry spans                           |
| 4. Source reading   | Internal behavior questions          | `swamp source fetch`                          |

## Symptom → tier index

| Symptom                                            | Start at                                                         |
| -------------------------------------------------- | ---------------------------------------------------------------- |
| Extension or binary misbehaves unexpectedly        | Before you start → version-drift check                           |
| "This used to work" / suspected regression         | Before you start → version-drift check                           |
| Extension not loaded / `swamp-warning:` on stderr  | Tier 1 → `swamp doctor extensions`                               |
| Run stuck in "running" / orphaned after crash      | Tier 1 → `swamp run doctor --fix`, then `swamp workflow recover` |
| "Is anything running right now?"                   | Tier 1 → `swamp run history --active`                            |
| Every command fails with `auth_gate_blocked`       | Account required → see below                                     |
| `datastore_format_unsupported` / `_marker_invalid` | Datastore format → see below                                     |
| Command errored — message is clear                 | Tier 2 → read it, fix the named issue                            |
| Command errored — message is vague                 | Tier 2 → re-run with `--json`                                    |
| Model method or workflow run failed                | Tier 2 → inspect generated reports                               |
| Workflow / method / sync is slow                   | Tier 3 → enable tracing                                          |
| Need to understand internal behavior               | Tier 4 → fetch source                                            |

### Account required (`auth_gate_blocked`)

Every subcommand except `auth login`, `auth logout`, `auth whoami`, `help`,
`completions`, `version`, `update` and the `--help`/`--version` flags needs a
swamp-club.com account. The message names the cause:

- **No account**: the user runs `swamp auth login` (browser sign-in they finish
  themselves). In CI, set `SWAMP_API_KEY` and `SWAMP_SIGNIN_TOKEN` from a
  collective token.
- **Revoked**: the key was deleted or the account suspended. Log in again.
- **Could not reach swamp-club / not verified in N days**: swamp verifies once
  online, then runs offline on a cached proof for up to 14 days. Fix the network
  and retry.
- **A serve or worker daemon blocks**: log in as the user who enabled it and
  re-run `swamp serve daemon enable` or `swamp worker daemon enable`.
- **`swamp` inside a workflow shell step**: it passes the gate on its parent's
  pass but gets no API key, so nested commands that call swamp-club
  (`extension push`/`pull`, `issue`, `auth whoami`) fail there. Run them as the
  outer command instead. On Windows, from a different swamp binary than the
  parent, or when the outer run passed offline on its signin token alone, the
  nested call needs its own login.
- **`worker connect` with no credential**: it passes on the pass of the serve
  that enrolls it, so worker pods need no key. If the message says the
  orchestrator did not vouch for it, upgrade swamp on the serve, check that the
  serve passed the gate on its own key, or give the worker a key
  (`SWAMP_API_KEY_FILE`).

Do not work around the block; there is no flag to skip it.

For detailed walkthroughs of each tier, see [reference.md](reference.md).

### Datastore format (`datastore_format_unsupported`, `datastore_format_marker_invalid`)

swamp refused the datastore before writing anything to it. A newer swamp marked
the datastore with a format this version cannot read: a `datastore-format.json`
file at a filesystem datastore's root, or the `_control/datastore-format` record
on S3/GCS.

- **`datastore_format_unsupported`**: upgrade swamp (`swamp update`) on this
  machine, CI and any pinned version. Never delete the marker to get past it:
  this version would read the newer layout as empty and corrupt it.
- **`datastore_format_marker_invalid`**: the marker exists but is not valid JSON
  with a positive integer `format`. Find out who wrote it before changing it;
  report it with `swamp issue bug` if swamp did.
