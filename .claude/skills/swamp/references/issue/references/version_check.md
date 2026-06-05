# Version Check

Detailed procedure for the `version_check` state in the bug report workflow. The
goal is to determine whether the bug you diagnosed has already been fixed in a
newer release before filing it.

## Step 1: Check for Updates

```bash
swamp update --check --json
```

Parse the JSON output:

- `{"status": "up_to_date", ...}` → the user is on the latest version. Result:
  **inconclusive** (no newer version to compare against). Advance to submit.
- `{"status": "update_available", "currentVersion": "...", "latestVersion": "..."}`
  → a newer version exists. Proceed to step 2 with the `latestVersion` value.

If the command fails, result: **inconclusive**. Advance to submit.

## Step 2: Fetch Latest Source

```bash
swamp source fetch --version <latestVersion>
```

Pass the `latestVersion` string from step 1 directly — the CLI adds the `v`
prefix automatically.

Then get the source path:

```bash
swamp source path --json
```

The `path` field in the JSON output is the root directory of the fetched source.

If either command fails, result: **inconclusive**. Advance to submit.

## Step 3: Re-read Diagnosed Files

If you did not investigate any source files during `gather_details` (e.g. the
user described the bug without code investigation), result: **inconclusive**.
Advance to submit.

Otherwise, read the files you investigated from the fetched source tree.

For each file you investigated (e.g.
`src/domain/workflows/execution_service.ts`), read it from the fetched source
path:

```
<source_path>/src/domain/workflows/execution_service.ts
```

If a file does not exist in the latest source (deleted or renamed), note that as
a signal that the code changed.

## Step 4: Compare and Decide

Compare what you see in the latest source against your diagnosis:

- **bug_fixed**: The code you identified as broken has been modified. The fix
  addresses the root cause you diagnosed. Tell the user:
  > "The code related to your bug has been updated in version `<latestVersion>`.
  > The issue appears to be fixed. Run `swamp update` to get the fix instead of
  > filing."
- **bug_present**: The relevant code is identical to what you diagnosed — the
  bug still exists in the latest version. Proceed to submit.
- **inconclusive**: The code changed but you cannot determine whether the change
  fixes this specific bug, or the diagnosed files were restructured and you
  cannot trace the issue. Proceed to submit.

When in doubt, prefer **inconclusive** over **bug_fixed** — it is better to file
a duplicate than to tell the user a bug is fixed when it is not.
