# Pre-flight Check Troubleshooting

## Pre-flight Check Failures

When a method fails with a check-related error (e.g., "Pre-flight check failed:
..."):

- Read the error messages returned by the failing check — they describe exactly
  what condition was not met.
- To identify which check failed, look at the check name in the error output.
- To skip a specific check temporarily:
  ```bash
  swamp model method run <name> <method> --skip-check <check-name>
  ```
- To skip all checks (e.g., in an offline environment where live API checks
  can't run):
  ```bash
  swamp model method run <name> <method> --skip-checks
  ```
- To skip all checks with a given label (e.g., `live` checks):
  ```bash
  swamp model method run <name> <method> --skip-check-label live
  ```
- To run only the checks (without running the method) to diagnose:
  ```bash
  swamp model validate <name> --method <method> --json
  ```
- To run only checks with a specific label:
  ```bash
  swamp model validate <name> --label offline --json
  ```
- Check source at `src/domain/models/` for the check's `execute` function to
  understand what it validates.

## Check Selection Errors

When `model validate` reports `Check selection` failed:

- **"Required check X not found on model type Y"** — the definition's
  `checks.require` references a check name that doesn't exist on the model type.
  Fix: run `swamp model type describe <type>` to see available checks, then
  correct the name in the YAML definition.
- **"Skipped check X not found on model type Y"** — same issue but for
  `checks.skip`. The check was removed or renamed in the extension.
- **"Check X is in both require and skip lists"** — the definition lists the
  same check in both `require` and `skip`. `skip` wins, but this is likely
  unintentional. Remove it from one list.

## Extension Check Conflicts

When an extension fails to load with "Check 'X' already exists on model type
'Y'":

- Two extensions define the same check name for the same model type.
- Fix: rename one of the checks in the extension's `checks` array.

## Required Check Won't Skip

If `--skip-checks` or `--skip-check <name>` doesn't skip a check, the
definition's `checks.require` list includes it. Required checks are immune to
CLI skip flags. To override: edit the YAML definition and remove the check from
`require`, or add it to `skip` (which always wins).
