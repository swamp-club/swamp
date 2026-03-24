# Publishing Extensions

Publish extension models, workflows, vaults, drivers, and datastores to the
swamp registry so others can install and use them.

## Manifest Schema (v1)

Create a `manifest.yaml` in your repository root (or any directory):

```yaml
manifestVersion: 1
name: "@myorg/my-extension"
version: "2026.02.26.1"
description: "Optional description of the extension"
models:
  - my_model.ts
  - utils/helper_model.ts
workflows:
  - my_workflow.yaml
additionalFiles:
  - README.md
platforms:
  - darwin-aarch64
  - linux-x86_64
labels:
  - aws
  - security
dependencies:
  - "@other/extension"
```

### Field Reference

| Field             | Required | Description                                                                                      |
| ----------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `manifestVersion` | Yes      | Must be `1`                                                                                      |
| `name`            | Yes      | Scoped name: `@collective/name` or `@collective/name/sub/path` (lowercase, hyphens, underscores) |
| `version`         | Yes      | CalVer format: `YYYY.MM.DD.MICRO`                                                                |
| `description`     | No       | Human-readable description                                                                       |
| `models`          | No*      | Model file paths relative to `extensions/models/`                                                |
| `workflows`       | No*      | Workflow file paths relative to `workflows/`                                                     |
| `vaults`          | No*      | Vault file paths relative to `extensions/vaults/`                                                |
| `drivers`         | No*      | Driver file paths relative to `extensions/drivers/`                                              |
| `datastores`      | No*      | Datastore file paths relative to `extensions/datastores/`                                        |
| `additionalFiles` | No       | Extra files relative to the manifest location                                                    |
| `platforms`       | No       | OS/architecture hints (e.g. `darwin-aarch64`, `linux-x86_64`)                                    |
| `labels`          | No       | Categorization labels (e.g. `aws`, `kubernetes`, `security`)                                     |
| `dependencies`    | No       | Other extensions this one depends on                                                             |

*At least one of `models`, `workflows`, `vaults`, `drivers`, or `datastores`
must be present with entries.

### Name Rules

- Must match pattern `@collective/name` or `@collective/name/sub/path` (e.g.,
  `@myorg/s3-tools`, `@myorg/aws/ec2`)
- Collective must match your authenticated username
- Reserved collectives (`@swamp`, `@si`) cannot be used
- Allowed characters: lowercase letters, numbers, hyphens, underscores

### How Content Maps to Manifest

- `models` paths resolve relative to `extensions/models/`
- `vaults` paths resolve relative to `extensions/vaults/`
- `drivers` paths resolve relative to `extensions/drivers/`
- `datastores` paths resolve relative to `extensions/datastores/`
- Only list entry-point files — local imports are auto-resolved and included
- Each entry-point is bundled into a standalone JS file for the registry

## Examples

### Models-only (simplest)

```yaml
manifestVersion: 1
name: "@myorg/s3-tools"
version: "2026.02.26.1"
models:
  - s3_bucket.ts
```

### Models + workflows

```yaml
manifestVersion: 1
name: "@myorg/deploy-suite"
version: "2026.02.26.1"
description: "Deployment automation models and workflows"
models:
  - ec2_instance.ts
  - security_group.ts
workflows:
  - deploy_stack.yaml
additionalFiles:
  - README.md
```

### Multi-model with dependencies

```yaml
manifestVersion: 1
name: "@myorg/monitoring"
version: "2026.02.26.1"
models:
  - cloudwatch_alarm.ts
  - sns_topic.ts
  - dashboard.ts
dependencies:
  - "@myorg/aws-core"
```

## Push Workflow

> **Before you push:** Your extension must pass
> `swamp extension fmt <manifest> --check`. The push command enforces this
> automatically — if your code has formatting or lint issues, the push will be
> rejected. Run `swamp extension fmt <manifest>` to auto-fix before pushing.

### Commands

```bash
# Full push to registry
swamp extension push manifest.yaml --json

# Validate locally without pushing (builds archive, runs safety checks)
swamp extension push manifest.yaml --dry-run --json

# Skip all confirmation prompts
swamp extension push manifest.yaml -y --json

# Specify a different repo directory
swamp extension push manifest.yaml --repo-dir /path/to/repo --json
```

### What Happens During Push

1. **Parse manifest** — validates schema, checks required fields
2. **Validate collective** — confirms manifest name matches your username
3. **Resolve files** — collects model entry points, auto-resolves local imports,
   resolves workflow dependencies
4. **Detect project config** — walks up from manifest directory to repo root
   looking for `deno.json` (takes priority) then `package.json`. If found and
   the extension uses bare specifiers, it is used for bundling. `deno.json` is
   also used for quality checks; `package.json` projects use default lint/fmt
   rules.
5. **Resolve include files** — collects files from the manifest's `include`
   field (if present). These are copied to the archive alongside model sources
   but not bundled or quality-checked.
6. **Safety analysis** — scans all files (including `include` files) for
   disallowed patterns and limits
7. **Quality checks** — runs `deno fmt --check` and `deno lint` on model, vault,
   driver, datastore, and report files (using the project's `deno.json` config
   if present, otherwise default rules). Include files are excluded.
8. **Bundle TypeScript** — compiles each entry point (models, vaults, drivers,
   datastores) to standalone JS. Include files are not bundled. If a `deno.json`
   is present, the import map governs dependency resolution.
9. **Version check** — verifies version doesn't already exist (offers to bump)
10. **Build archive** — creates tar.gz with all content types and their bundles
11. **Upload** — three-phase push: initiate, upload archive, confirm

## Extension Formatting

Format and lint extension files before publishing. The `extension fmt` command
resolves all TypeScript files referenced by the manifest (model entry points and
their local imports), then runs `deno fmt` and `deno lint --fix` on them.

### Commands

```bash
# Auto-fix formatting and lint issues
swamp extension fmt manifest.yaml --json

# Check-only mode (exit non-zero if issues exist, does not modify files)
swamp extension fmt manifest.yaml --check --json

# Specify a different repo directory
swamp extension fmt manifest.yaml --repo-dir /path/to/repo --json
```

### What Happens During Fmt

1. **Parse manifest** — reads the manifest and resolves model/workflow file
   paths
2. **Resolve files** — collects all TypeScript files (entry points + local
   imports) referenced by the manifest
3. **Run `deno fmt`** — formats all resolved files (or checks in `--check` mode)
4. **Run `deno lint --fix`** — auto-fixes lint issues (or checks in `--check`
   mode)
5. **Re-check** — if any unfixable lint issues remain, reports them and exits
   non-zero

### Relationship to Push

`swamp extension push` automatically runs the equivalent of `--check` before
uploading. If formatting or lint issues are detected, the push is blocked with a
message directing you to run `swamp extension fmt <manifest-path>` to fix them.

## Safety Rules

The safety analyzer scans all files before push. Issues are classified as
**errors** (block the push) or **warnings** (prompt for confirmation).

### Errors (block push)

| Rule                        | Detail                                              |
| --------------------------- | --------------------------------------------------- |
| `eval()` / `new Function()` | Dynamic code execution not allowed in `.ts` files   |
| Symlinks                    | Symlinked files are not allowed                     |
| Hidden files                | Files starting with `.` are not allowed             |
| Disallowed extensions       | Only `.ts`, `.json`, `.md`, `.yaml`, `.yml`, `.txt` |
| File too large              | Individual files must be under 1 MB                 |
| Total size exceeded         | All files combined must be under 10 MB              |
| Too many files              | Maximum 150 files per extension                     |

### Warnings (prompted)

| Rule             | Detail                                              |
| ---------------- | --------------------------------------------------- |
| `Deno.Command()` | Subprocess spawning detected                        |
| Long lines       | Lines with 500+ non-whitespace characters           |
| Base64 blobs     | Strings that look like base64 (100+ matching chars) |

## CalVer Versioning

Extensions use Calendar Versioning: `YYYY.MM.DD.MICRO`

- `YYYY` — four-digit year
- `MM` — two-digit month (zero-padded)
- `DD` — two-digit day (zero-padded)
- `MICRO` — incrementing integer (starts at 1)

**Examples:** `2026.02.26.1`, `2026.02.26.2`, `2026.03.01.1`

The date must be today or earlier. If you push a version that already exists,
the CLI will offer to bump the `MICRO` component automatically.

## Common Errors and Fixes

| Error                           | Fix                                                                     |
| ------------------------------- | ----------------------------------------------------------------------- |
| "Not authenticated"             | Run `swamp auth login` first                                            |
| "collective does not match"     | Manifest `name` must use `@your-username/...`                           |
| "CalVer format" error           | Use `YYYY.MM.DD.MICRO` (e.g., `2026.02.26.1`)                           |
| "at least one model, workflow…" | Add a `models`, `workflows`, `vaults`, `drivers`, or `datastores` array |
| "Model file not found"          | Check path is relative to `extensions/models/`                          |
| "Workflow file not found"       | Check path is relative to `workflows/`                                  |
| "eval() or new Function()"      | Remove dynamic code execution from your models                          |
| "Version already exists"        | Bump the MICRO component or let CLI auto-bump                           |
| "Missing manifestVersion"       | Add `manifestVersion: 1` to your manifest                               |
| "Bundle compilation failed"     | Fix TypeScript errors in your model files                               |
