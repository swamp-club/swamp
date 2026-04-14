---
name: swamp-extension-publish
description: Publish swamp extensions to the registry with an enforced state-machine checklist that verifies repo initialization, authentication, manifest validation, collective ownership, version bumping, formatting, and dry-run before allowing a push. Use when publishing, pushing, or releasing extensions. Triggers on "publish extension", "push extension", "extension push", "publish to registry", "swamp extension push", "release extension", "prepare for publishing", "extension-publish".
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

**Core rule:** If any Verify fails, execute the On Failure action. Never skip a
state. Never reorder states. The user cannot push until all gates have passed.

## Before Starting

Present the full checklist to the user so they know what to expect:

> **Publishing checklist — 8 steps must pass before push:**
>
> 1. **Repository** — verify `.swamp.yaml` exists (swamp repo initialized)
> 2. **Authentication** — verify logged in to swamp registry
> 3. **Manifest** — validate `manifest.yaml` structure and file references
> 4. **Collective** — verify manifest name matches authenticated user
> 5. **Version** — get next CalVer version and bump manifest
> 6. **Formatting** — run `swamp extension fmt` and verify clean
> 7. **Dry run** — validate push without uploading
> 8. **Push** — publish to registry (requires your explicit approval)
>
> Starting now. I'll report progress at each step.

Then begin with State 1.

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

**On Failure:** The directory is not a swamp repository. Run:

```bash
swamp repo init --json
```

Then re-verify. If `swamp repo init` fails, check that swamp is installed and up
to date (`swamp update`).

## State 2: auth_verified

Confirm the user is authenticated with the swamp registry.

**Gate:** State 1 passed (`.swamp.yaml` exists).

**Action:**

```bash
swamp auth whoami --json
```

**Verify:** The output contains a `username` field and `authenticated: true`.

**On Failure:** The user is not logged in. Run:

```bash
swamp auth login
```

Then re-verify. If login fails, check network connectivity and credentials.

## State 3: manifest_validated

Confirm `manifest.yaml` exists and is structurally valid.

**Gate:** State 2 passed (authenticated).

**Action:** Read `manifest.yaml` and validate:

1. `manifestVersion: 1` is present
2. `name` is present and matches `@collective/name` format
3. At least one content array (`models`, `workflows`, `vaults`, `drivers`,
   `datastores`, or `reports`) has entries
4. All referenced files exist at their expected paths (models in
   `extensions/models/`, workflows in `workflows/`, etc.)

**Verify:** All 4 checks pass.

**On Failure:** Report which checks failed. Common fixes:

- Missing `manifestVersion` → add `manifestVersion: 1`
- Invalid name → use `@collective/extension-name` format
- No content arrays → add at least one of `models`, `workflows`, `skills`, etc.
- Missing files → create the files or fix the paths

See [references/publishing.md](references/publishing.md) for the full manifest
schema and field reference.

## State 4: collective_verified

Confirm the manifest collective matches the authenticated user.

**Gate:** State 3 passed (manifest is valid).

**Action:** Extract the collective from the manifest `name` field (the part
between `@` and `/`). Compare it against the `username` from
`swamp auth whoami --json`.

**Verify:** The collective matches the authenticated username, or the user has
confirmed they have permission to publish under this collective.

**On Failure:** Collective mismatch. Report:

> Manifest collective `@<collective>` does not match your authenticated username
> `<username>`. Either:
>
> 1. Update the manifest `name` to use `@<username>/...`
> 2. Confirm you have publishing rights to `@<collective>`

Do not proceed until the user resolves this.

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

**On Failure:**

- If the extension has never been published, `currentPublished` will be `null` —
  this is normal. Use `nextVersion` as-is.
- If the command fails, check that the manifest `name` is valid and the registry
  is reachable.

See [references/publishing.md](references/publishing.md#calver-versioning) for
CalVer format details.

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

**On Failure:** If `--check` reports issues after formatting, there are
unfixable lint errors. Read the error output, fix the issues manually, then
re-run `swamp extension fmt manifest.yaml`.

See [references/publishing.md](references/publishing.md#extension-formatting)
for details on what fmt checks.

## State 7: dry_run_passed

Validate the extension can be pushed without actually uploading.

**Gate:** State 6 passed (formatting clean).

**Action:**

```bash
swamp extension push manifest.yaml --dry-run --json
```

**Verify:** The command exits successfully. Review the output for any warnings
(subprocess spawning, long lines, base64 blobs) and confirm with the user if
warnings are present.

**On Failure:** Read the error output. Common issues:

- `eval()` or `new Function()` → remove dynamic code execution
- Symlinks → replace with regular files
- File too large → reduce file size below 1 MB
- Too many files → reduce to under 150 files
- Bundle compilation failed → fix TypeScript errors

See [references/publishing.md](references/publishing.md#safety-rules) for the
full list of safety rules.

## State 8: pushed

Publish the extension to the registry.

**CRITICAL: Do NOT run the push command automatically.** Always stop and ask the
user for explicit confirmation. Present the summary and wait.

**Gate:** ALL prior states (1–7) have passed. Present this summary and STOP:

> All pre-publish checks passed:
>
> - Repository: initialized
> - Auth: verified as `<username>`
> - Manifest: valid
> - Collective: `@<collective>` matches auth
> - Version: `YYYY.MM.DD.MICRO`
> - Formatting: clean
> - Dry run: passed
>
> Ready to push `@collective/extension-name` version `YYYY.MM.DD.MICRO` to the
> registry. **Shall I proceed?**

**Action:** Only after the user explicitly says yes, approved, go, or proceed:

```bash
swamp extension push manifest.yaml --yes --json
```

**Verify:** The command exits successfully and reports the published version.

**On Failure:** If the push fails:

- Version already exists → bump the MICRO component and retry
- Network error → check connectivity and retry
- Auth error → re-run `swamp auth login` (go back to State 2)

## References

- **Publishing Details**: See
  [references/publishing.md](references/publishing.md) for manifest schema,
  field reference, CalVer versioning, safety rules, and common errors
- **Extension Creation**: Use the `swamp-extension-model`,
  `swamp-extension-vault`, `swamp-extension-datastore`, or
  `swamp-extension-driver` skills to create extension code before publishing

## When to Use Other Skills

| Need                            | Use Skill                   |
| ------------------------------- | --------------------------- |
| Create custom models            | `swamp-extension-model`     |
| Create custom vaults            | `swamp-extension-vault`     |
| Create custom datastores        | `swamp-extension-datastore` |
| Create custom execution drivers | `swamp-extension-driver`    |
| Repository setup and management | `swamp-repo`                |
| Create reports                  | `swamp-report`              |
