# Version-Drift Check

Run before entering the diagnostic tiers. A stale swamp binary or extension is a
common root cause for unexpected behavior — the check is cheap and can
short-circuit hours of investigation.

## Step 1: Check the swamp binary

```bash
swamp update --check --json
```

Parse the JSON output:

- `{"status": "up_to_date", ...}` → the binary is current. Proceed to step 2.
- `{"status": "update_available", "currentVersion": "...", "latestVersion": "..."}`
  → a newer binary exists. Run `swamp update` to install it, then retry the
  failing operation. If the problem is resolved, stop — no further diagnosis
  needed.

If the command fails, note it and proceed to step 2.

## Step 2: Check installed extensions

```bash
swamp extension outdated
```

This lists every installed extension that has a newer version available. It
exits 1 if any update is available (suitable for CI gates).

- **No output / exit 0** → all extensions are current. Proceed to the diagnostic
  tiers.
- **Updates listed / exit 1** → one or more extensions are behind. Pull the
  updated extensions:

  ```bash
  swamp extension pull <name>    # pull a specific extension
  ```

  Then retry the failing operation. If the problem is resolved, stop.

If the command fails, note it and proceed to the diagnostic tiers.

## Step 3: Decide

| Binary   | Extensions | Action                                  |
| -------- | ---------- | --------------------------------------- |
| Current  | Current    | Proceed to Tier 1 (health checks)       |
| Updated  | —          | Retry the operation; if fixed, stop     |
| —        | Updated    | Retry the operation; if fixed, stop     |
| Updated  | Updated    | Retry the operation; if fixed, stop     |
| Failures | Failures   | Note the failures and proceed to Tier 1 |

The version-drift check is a quick gate, not a deep analysis. If updating
resolves the issue, no further diagnosis is needed. If the problem persists
after updating (or if the checks themselves fail), move on to the diagnostic
tiers — the issue is not caused by staleness.
