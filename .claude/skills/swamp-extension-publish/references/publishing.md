# Publishing Extensions

Publish extension models, workflows, vaults, drivers, and datastores to the
swamp registry so others can install and use them.

## Repository Prerequisite

The extension directory **must be an initialized swamp repository** before
`swamp extension fmt` or `swamp extension push` will work. Both commands require
a `.swamp.yaml` marker file (created by `swamp repo init`).

If you see `Not a swamp repository` errors, run:

```bash
swamp repo init --json
```

This creates `.swamp.yaml` and the standard directory structure. For monorepos
with multiple extensions, each subdirectory that needs to publish independently
must have its own `swamp repo init`.

## Manifest Schema (v1)

Create a `manifest.yaml` in your repository root (or any directory):

```yaml
manifestVersion: 1
name: "@myorg/my-extension"
version: "2026.02.26.1"
description: "Optional description of the extension"
repository: "https://github.com/myorg/my-extension"
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

| Field             | Required | Description                                                                                                                                       |
| ----------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifestVersion` | Yes      | Must be `1`                                                                                                                                       |
| `name`            | Yes      | Scoped name: `@collective/name` or `@collective/name/sub/path` (lowercase, hyphens, underscores)                                                  |
| `version`         | Yes      | CalVer format: `YYYY.MM.DD.MICRO`                                                                                                                 |
| `description`     | No       | Human-readable description                                                                                                                        |
| `repository`      | No       | HTTPS URL of the upstream repository. Required for users to file issues via `swamp issue --extension` — `swamp extension push` warns when absent. |
| `paths.base`      | No       | Path resolution mode for typed keys + `additionalFiles`. `typedDir` (default) or `manifest`. See "Path resolution".                               |
| `models`          | No*      | Model file paths. Resolved via `paths.base`.                                                                                                      |
| `workflows`       | No*      | Workflow file paths. Workflows use a multi-base lookup and ignore `paths.base`.                                                                   |
| `vaults`          | No*      | Vault file paths. Resolved via `paths.base`.                                                                                                      |
| `drivers`         | No*      | Driver file paths. Resolved via `paths.base`.                                                                                                     |
| `datastores`      | No*      | Datastore file paths. Resolved via `paths.base`.                                                                                                  |
| `reports`         | No*      | Report file paths. Resolved via `paths.base`.                                                                                                     |
| `skills`          | No*      | Skill directory names resolved from the tool's skill directory (e.g., `.claude/skills/`). Skills ignore `paths.base`.                             |
| `include`         | No       | Helper TypeScript files copied alongside models without bundling. Resolved via `paths.base`.                                                      |
| `additionalFiles` | No       | Extra files (README, LICENSE, etc.) relative to the manifest's own directory.                                                                     |
| `platforms`       | No       | OS/architecture hints (e.g. `darwin-aarch64`, `linux-x86_64`)                                                                                     |
| `labels`          | No       | Categorization labels (e.g. `aws`, `kubernetes`, `security`)                                                                                      |
| `dependencies`    | No       | Other extensions this one depends on                                                                                                              |

*At least one of `models`, `workflows`, `vaults`, `drivers`, `datastores`,
`reports`, or `skills` must be present with entries.

### additionalFiles — directory structure and runtime access

`additionalFiles` preserves directory structure through push/pull. An entry
`prompts/review.md` lands in the archive at `files/prompts/review.md`, and
pulled consumers find it at
`.swamp/pulled-extensions/<name>/files/prompts/review.md`.

Push rejects:

- **Duplicate entries** (case-insensitive, NFC-normalized). Two entries that
  would resolve to the same archive path fail with a clear error — fix the
  manifest before re-running push.
- **Symlinks**. Entries pointing at symlinks are rejected to prevent archive
  bloat and path escapes. Copy the target file into the extension tree instead.

At runtime, models and reports receive `ctx.extensionFile(relPath)` which
returns the absolute path to a bundled asset. The helper works identically
whether the extension is source-loaded or pulled, so the same code runs in both
local development and production:

```ts
export const model = {
  type: "@myorg/ext/demo",
  version: "2026.04.22.1",
  methods: {
    run: {
      arguments: z.object({}),
      execute: async (_args, ctx) => {
        const path = ctx.extensionFile("prompts/review.md");
        return { dataHandles: [] };
      },
    },
  },
};
```

Use `ctx.extensionFile()` instead of hardcoding `.swamp/pulled-extensions/`
paths — hardcoding breaks smoke tests run against a source-loaded extension.

### Path resolution — `paths.base`

This is the canonical reference for path resolution semantics across all
extension-type skills (model, vault, driver, datastore, report). Other skills
link here.

> **The default is the existing path resolution. Omit `paths.base` and nothing
> about your manifest changes — historical behavior end to end.** The
> implementation is a single ternary: when `paths.base: manifest` is set, the
> resolver and archive layout switch to a manifest-relative base; otherwise they
> use the configured typed dir as before. There is no implicit detection, no
> fallback, no "best guess" — opt in to opt in.

`paths.base` selects which directory typed-key entries (`models`, `vaults`,
`drivers`, `datastores`, `reports`, `include`) and `additionalFiles` resolve
against during push. Two modes:

| Mode                 | Typed keys resolve relative to                        | `additionalFiles` resolves relative to |
| -------------------- | ----------------------------------------------------- | -------------------------------------- |
| `typedDir` (default) | Configured directory (`modelsDir`, `vaultsDir`, etc.) | Manifest's own directory               |
| `manifest`           | Manifest's own directory                              | Manifest's own directory               |

Existing manifests without an explicit `paths.base` keep their semantics
unchanged — every published extension on the registry today is on the `typedDir`
path and stays there. The opt-in is purely additive.

Pick `manifest` for **per-extension-subdir layouts**: each extension lives in
its own subdirectory under the configured typed dir, with manifest, source,
README, and LICENSE all alongside each other. This is the layout the quality
rubric rewards (README and LICENSE land at the archive root via
`additionalFiles`) without requiring directory prefixes on `models:` or other
typed entries.

#### Side-by-side example

Default (`paths.base: typedDir`) — manifest sits inside `modelsDir` or at a
per-extension repo root with code under `./extensions/models/`:

```
extensions/models/manifest.yaml          # or:    my-ext/manifest.yaml
extensions/models/echo.ts                #        my-ext/extensions/models/echo.ts
extensions/models/utils/helper.ts        #        my-ext/extensions/models/utils/helper.ts
```

```yaml
# manifest.yaml
manifestVersion: 1
name: "@me/my-ext"
version: "2026.04.29.1"
models:
  - echo.ts
  - utils/helper.ts
additionalFiles:
  - README.md # alongside manifest
```

Opt-in (`paths.base: manifest`) — each extension is a self-contained directory
under `modelsDir`:

```
extensions/models/my-ext/manifest.yaml
extensions/models/my-ext/echo.ts
extensions/models/my-ext/utils/helper.ts
extensions/models/my-ext/README.md
```

```yaml
# manifest.yaml
manifestVersion: 1
name: "@me/my-ext"
version: "2026.04.29.1"
paths:
  base: manifest
models:
  - echo.ts
  - utils/helper.ts
additionalFiles:
  - README.md
```

#### What does NOT change with `paths.base: manifest`

- The on-wire manifest in the archive is byte-equivalent to your source manifest
  — no path rewriting, no normalization. WYSIWYG.
- The archive layout under each typed dir mirrors your manifest entries
  verbatim: `models: [echo.ts]` lands at `extension/models/echo.ts` in the
  archive (not at `extension/models/my-ext/echo.ts`).
- Workflows and skills keep their own multi-base lookup. `paths.base` does not
  apply to those keys.

### Name Rules

- Must match pattern `@collective/name` or `@collective/name/sub/path` (e.g.,
  `@myorg/s3-tools`, `@myorg/aws/ec2`)
- Collective must match your authenticated username
- Reserved collectives (`@swamp`, `@si`) cannot be used
- Allowed characters: lowercase letters, numbers, hyphens, underscores

### Collective Validation

| Type                        | Valid? | Notes                       |
| --------------------------- | ------ | --------------------------- |
| `@user/my-model`            | Yes    | Valid collective            |
| `@myorg/deploy`             | Yes    | Custom collective allowed   |
| `myorg/my-model`            | Yes    | Non-@ format allowed        |
| `digitalocean/app-platform` | Yes    | Non-@ multi-segment allowed |
| `@user/aws/s3`              | Yes    | Nested paths allowed        |
| `swamp/my-model`            | No     | Reserved collective         |
| `si/my-model`               | No     | Reserved collective         |

### Import Rules

`import { z } from "npm:zod@4";` is the canonical zod import for entrypoint
files. Two distinct constraints make this the right form:

- **Hermeticity at score time.** The swamp-club scorer and the local
  `swamp extension quality` command both run in a sandbox that strips the
  tarball's `deno.json` and writes its own with `nodeModulesDir: "auto"` and no
  imports map. Bare specifiers like `from "zod"` resolve at bundle time via the
  repo's `deno.json` import map, but fail at score time — `deno doc --json`
  cannot find the bare name and the command throws before factor scoring begins.
  The inline `npm:` form is the only form that resolves under both the bundler's
  permissive resolution AND the scorer's hermetic resolution.
- **Zod externalization.** Zod is the sole import that is NOT inlined into the
  published bundle. The extension must share swamp's zod instance so schema
  `instanceof` checks work across the module boundary — that is why zod in
  particular is called out as the canonical inline form, not merely a
  consequence of hermeticity.

Other Deno-compatible imports (`npm:`, `jsr:`, `https://`) are inlined into the
bundle by the swamp packager. Bare specifiers backed by `deno.json` or
`package.json` work for the bundler, but follow the hermeticity rule above for
anything that needs to score: prefer the inline form in entrypoint files.

- All imports must be static top-level imports — dynamic `import()` calls are
  rejected during push
- Always pin versions on all non-local imports for reproducibility. An unpinned
  specifier resolves to the registry's current "latest" at push time, so the
  published bundle silently changes across pushes. Examples:
  - `npm:lodash-es@4.17.21` (inline), or via `deno.json` import map, or in
    `package.json` dependencies
  - `jsr:@std/assert@1.0.0` (inline) or via `deno.json` import map
  - `https://deno.land/std@0.224.0/async/delay.ts` (the version lives in the
    URL)
- Use `include` in the manifest for helper scripts executed via `Deno.Command`
  that shouldn't be bundled

See [examples.md](examples.md#import-styles) for import style examples and
[examples.md](examples.md#helper-scripts) for helper script details.

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

### Model + report

```yaml
manifestVersion: 1
name: "@myorg/ports"
version: "2026.03.01.1"
models:
  - ports.ts
reports:
  - port_whisperer.ts
```

## Pre-Push Checklist

0. **Verify swamp repository**: Confirm `.swamp.yaml` exists — run
   `swamp repo init --json` if missing
1. **Get next version**:
   `swamp extension version --manifest manifest.yaml --json`
2. **Bump version** in `manifest.yaml` — use `nextVersion` from the output above
3. **Format & lint**: `swamp extension fmt manifest.yaml`
4. **(Optional) Quality score**: `swamp extension quality manifest.yaml --json`
   — see the `swamp-extension` skill for the rubric. Packages and caches the
   tarball at `.swamp/cache/packages/<hash>/`; the cache is reused by the
   dry-run and push below if source hasn't changed.
5. **Dry-run push**: `swamp extension push manifest.yaml --dry-run --json`
6. **Push**: `swamp extension push manifest.yaml --yes --json`

### Opportunistic package cache

`swamp extension quality`, `swamp extension push --dry-run`, and
`swamp extension push` all consult a content-hash-keyed cache at
`.swamp/cache/packages/<hash>/`. The hash is derived from the manifest, every
referenced source file, and the deno/package-json configuration — so any source
change invalidates the entry by construction. The cache is a pure optimization:
a cache miss falls back to fresh packaging. The cache is never load-bearing for
correctness and can be deleted safely at any time.

## Push Workflow

> **Before you push:** Your extension directory must be an initialized swamp
> repository (`.swamp.yaml` must exist). Your extension must also pass
> `swamp extension fmt <manifest> --check`. The push command enforces formatting
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

| Rule                        | Detail                                                                  |
| --------------------------- | ----------------------------------------------------------------------- |
| `eval()` / `new Function()` | Dynamic code execution not allowed in `.ts` files                       |
| Symlinks                    | Symlinked files are not allowed                                         |
| Hidden files                | Files starting with `.` are not allowed                                 |
| Disallowed extensions       | Only `.ts`, `.json`, `.md`, `.yaml`, `.yml`, `.txt` (`binaries` exempt) |
| File too large              | Individual files must be under 1 MB                                     |
| Total size exceeded         | All files combined must be under 10 MB                                  |
| Too many files              | Maximum 150 files per extension                                         |

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

### Determining the Next Version

Use `swamp extension version` to query the registry and compute the correct next
version:

```bash
# By extension name
swamp extension version @myorg/my-ext --json

# By manifest file
swamp extension version --manifest manifest.yaml --json
```

**JSON output:**

```json
{
  "extensionName": "@myorg/my-ext",
  "currentPublished": "2026.03.25.3",
  "publishedAt": "2026-03-25T14:30:00Z",
  "nextVersion": "2026.03.30.1"
}
```

- Use `nextVersion` as the new `version` in your model and manifest
- Use `currentPublished` as the `fromVersion` in upgrade chain entries
- If `currentPublished` is `null`, the extension has never been published

## Common Errors and Fixes

| Error                           | Fix                                                                               |
| ------------------------------- | --------------------------------------------------------------------------------- |
| "Not a swamp repository"        | Run `swamp repo init --json` in the extension directory                           |
| "Not authenticated"             | Run `swamp auth login` first                                                      |
| "collective does not match"     | Manifest `name` must use `@your-username/...`                                     |
| "CalVer format" error           | Use `YYYY.MM.DD.MICRO` (e.g., `2026.02.26.1`)                                     |
| "at least one model, workflow…" | Add a `models`, `workflows`, `vaults`, `drivers`, `datastores`, or `skills` array |
| "Model file not found"          | Check path is relative to `extensions/models/`                                    |
| "Workflow file not found"       | Check path is relative to `workflows/`                                            |
| "eval() or new Function()"      | Remove dynamic code execution from your models                                    |
| "Version already exists"        | Bump the MICRO component or let CLI auto-bump                                     |
| "Missing manifestVersion"       | Add `manifestVersion: 1` to your manifest                                         |
| "Bundle compilation failed"     | Fix TypeScript errors in your model files                                         |

## Related Skills

| Need                               | Use Skill         |
| ---------------------------------- | ----------------- |
| Create custom models               | `swamp-extension` |
| Create custom vaults               | `swamp-extension` |
| Create custom datastores           | `swamp-extension` |
| Create custom execution drivers    | `swamp-extension` |
| Repository setup and management    | `swamp-repo`      |
| Create reports                     | `swamp-report`    |
| Quality scorecard & best practices | `swamp-extension` |

## Quality Self-Check

Run between formatting (State 6) and dry-run (State 7):

```bash
swamp extension quality manifest.yaml --json
```

Scores the extension against the 10 client-earnable Swamp Club quality factors
(README, LICENSE, JSDoc coverage, repository URL, manifest completeness,
slow-type diagnostics, etc.) and prints per-factor results with remediation
hints. The packaged tarball is written to `.swamp/cache/packages/<hash>/` and
reused by dry-run and push when the source tree hasn't changed.

This step is optional — skipping does not block the push. See the
`swamp-extension` skill for the full rubric and per-factor guidance.
