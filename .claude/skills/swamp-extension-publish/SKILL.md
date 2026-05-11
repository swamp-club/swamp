---
name: swamp-extension-publish
description: >
  Publish swamp extensions to the registry with an enforced state-machine
  checklist that verifies repo initialization, authentication, manifest
  validation, collective ownership, version bumping, formatting, and dry-run
  before allowing a push. Do NOT use for creating extensions (that is
  swamp-extension), improving quality scores (that is swamp-extension), or
  smoke testing extensions before push (that is swamp-extension). Use when
  publishing, pushing, or releasing extensions. Triggers on "publish
  extension", "push extension", "extension push", "publish to registry",
  "swamp extension push", "release extension", "prepare for publishing",
  "extension-publish".
---

# Swamp Extension Publish

Publish extensions (models, workflows, vaults, drivers, datastores, reports) to
the swamp registry. This skill is a **state machine** — each state gates the
next. You MUST NOT advance to the next state until the current state's
**Verify** step passes. The final push is blocked until every prior state has
passed.

## State Machine

```
start → repo_verified → auth_verified → manifest_validated
      → versioned → formatted → dry_run_passed → pushed
```

## State 1: repo_verified

Confirm the extension directory is an initialized swamp repository.

**Gate:** The user has a directory containing extension code and a
`manifest.yaml`.

**Action:**

```bash
ls .swamp.yaml
```

**Verify:** The file exists and is valid YAML. If you are in a subdirectory,
check parent directories up to the filesystem root.

**On Failure:** Run `swamp repo init --json`, then re-verify.

## State 2: auth_verified

Confirm the user is authenticated with the swamp registry.

**Gate:** State 1 passed (`.swamp.yaml` exists).

**Action:**

```bash
swamp auth whoami --json
```

**Verify:** The output contains a `username` field and `authenticated: true`.

**On Failure:** Run `swamp auth login`, then re-verify.

## State 3: manifest_validated

Confirm `manifest.yaml` exists and is structurally valid.

**Gate:** State 2 passed (authenticated).

**Action:** Read `manifest.yaml` and validate the 4 required checks documented
in [references/publishing.md](references/publishing.md#manifest-validation)
(`manifestVersion`, `name` format, content arrays, file paths).

**Verify:** All 4 checks pass.

**On Failure:** Report which checks failed. See
[references/publishing.md](references/publishing.md#manifest-validation) for the
checklist and common fixes.

## State 4: collective_verified

Confirm the manifest collective matches the authenticated user.

**Gate:** State 3 passed (manifest is valid).

**Action:** Extract the collective from the manifest `name` field (the part
between `@` and `/`). Compare it against the `username` from
`swamp auth whoami --json`.

**Verify:** The collective matches the authenticated username, or the user has
confirmed they have permission to publish under this collective.

**On Failure:** Collective mismatch — ask the user to update the manifest `name`
or confirm publishing rights. Do not proceed until resolved.

## State 5: versioned

Get the next version and bump the manifest.

**Gate:** State 4 passed (collective verified).

**Action:**

```bash
swamp extension version --manifest manifest.yaml --json
```

**Verify:** The command succeeds and returns a `nextVersion` field. Update
`manifest.yaml` with this version. If the model source file also contains a
`version` field, update it to match.

**On Failure:** If `currentPublished` is `null`, use `nextVersion` as-is (first
publish). Otherwise check manifest `name` and registry connectivity. See
[references/publishing.md](references/publishing.md#calver-versioning) for
CalVer details.

## State 6: formatted

Format and lint all extension files.

**Gate:** State 5 passed (version bumped).

**Action:**

```bash
swamp extension fmt manifest.yaml --json
```

**Verify:** The command exits successfully (exit code 0). Run the check mode to
confirm:

```bash
swamp extension fmt manifest.yaml --check --json
```

**On Failure:** Fix lint errors reported by `--check`, then re-run fmt. See
[references/publishing.md](references/publishing.md#extension-formatting) for
details.

**Optional:** Run `swamp extension quality manifest.yaml --json` between States
6 and 7 for a rubric score. See
[references/publishing.md](references/publishing.md#quality-self-check) for
details.

## State 7: dry_run_passed

Validate the extension can be pushed without actually uploading.

**Gate:** State 6 passed (formatting clean).

**Action:**

```bash
swamp extension push manifest.yaml --dry-run --json
```

**Verify:** Exit code 0. Confirm any warnings with the user.

**On Failure:** See
[references/publishing.md](references/publishing.md#safety-rules).

## State 8: pushed

Publish the extension to the registry.

**CRITICAL: Do NOT push automatically.** Present summary and wait for explicit
user confirmation.

**Gate:** ALL prior states (1–7) passed. Ask: "Ready to push
`@collective/name@YYYY.MM.DD.MICRO`. Shall I proceed?"

**Action:** Only after explicit user approval:

```bash
swamp extension push manifest.yaml --yes --json
```

**Verify:** The command exits successfully and reports the published version.

**On Failure:** If the push fails:

- Version already exists → bump the MICRO component and retry
- Network error → check connectivity and retry
- Auth error → re-run `swamp auth login` (go back to State 2)

## References

See [references/publishing.md](references/publishing.md) for manifest schema,
field reference, CalVer versioning, safety rules, related skills, and common
errors.
