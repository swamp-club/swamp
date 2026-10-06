# Publishing Extensions

Publish extension models, workflows, vaults, and datastores to the swamp
registry so others can install and use them.

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

| Field             | Required | Description                                                                                                                                              |
| ----------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifestVersion` | Yes      | Must be `1`                                                                                                                                              |
| `name`            | Yes      | Scoped name: `@collective/name` or `@collective/name/sub/path` (lowercase, hyphens, underscores)                                                         |
| `version`         | Yes      | CalVer format: `YYYY.MM.DD.MICRO`                                                                                                                        |
| `description`     | No       | Human-readable description                                                                                                                               |
| `visibility`      | No       | `public` (registry default) or `private`. Optional `--visibility` overrides this field; omitting both preserves registry defaults.                       |
| `repository`      | No       | HTTPS URL of the upstream repository. Required for users to file issues via `swamp issue --extension` — `swamp extension push` warns when absent.        |
| `paths.base`      | No       | Path resolution mode for typed keys + `additionalFiles`. `typedDir` (default) or `manifest`. See "Path resolution".                                      |
| `models`          | No*      | Model file paths. Resolved via `paths.base`.                                                                                                             |
| `workflows`       | No*      | Workflow file paths. Resolved via `paths.base`. Under `manifest`, resolves from manifest dir first, then the extensions root and repo-root fallbacks.    |
| `vaults`          | No*      | Vault file paths. Resolved via `paths.base`.                                                                                                             |
| `datastores`      | No*      | Datastore file paths. Resolved via `paths.base`.                                                                                                         |
| `reports`         | No*      | Report file paths. Resolved via `paths.base`.                                                                                                            |
| `skills`          | No*      | Skill directory names. Honours `paths.base: manifest` (manifest-relative first, then the extensions root, then project-local; never `~/.claude/skills`). |
| `include`         | No       | Helper TypeScript files copied alongside models without bundling. Resolved via `paths.base`.                                                             |
| `additionalFiles` | No       | Extra files (README, LICENSE, etc.) relative to the manifest's own directory.                                                                            |
| `platforms`       | No       | OS/architecture hints (e.g. `darwin-aarch64`, `linux-x86_64`)                                                                                            |
| `labels`          | No       | Categorization labels (e.g. `aws`, `kubernetes`, `security`)                                                                                             |
| `dependencies`    | No       | Other extensions this one depends on                                                                                                                     |

*At least one of `models`, `workflows`, `vaults`, `datastores`, `reports`, or
`skills` must be present with entries.

### Private publication

To require private publication, set `visibility: private` in the manifest or use
the optional flag on both preview and publish:

```bash
swamp extension push manifest.yaml --visibility private --dry-run --json
swamp extension push manifest.yaml --visibility private --yes --json
```

Use CLI choice > manifest > registry default. Accept `public` or `private` as
explicit values. `visibility: public` and `--visibility public` select the
existing registry behavior: new extensions follow the collective's default and
existing extensions keep their visibility. Use `--visibility public` to override
a private manifest; it does not convert an already-private extension to public.
Only private intent is sent to the registry; public omits the request field.

Preview/dry-run `visibility` is `public`, `private` or `default` (registry
decides); successful publication reports applied `public` or `private`. With
credentials, a dry run runs the registry checks read-only, including
private-entitlement for private intent (see "What the dry run checks"). An
explicit private publish requires a private confirmation response. On a
confirmation error, check registry state before retrying: publication may
already have completed.

Use a registry fully upgraded for private publication (Lab #2200), on every
replica. Older servers ignore the field; confirmation validation cannot prevent
that exposure. Complete rollout before explicit-private publication and pause it
during service rollback. The registry supports private extensions in public
collectives and checks permissions/entitlements. An already-public extension
returns a conflict; change its visibility through the registry before publishing
privately. Omitting both field and flag retains existing defaults.

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
extension-type skills (model, vault, datastore, report). Other skills link here.

> **The default is the existing path resolution. Omit `paths.base` and nothing
> about your manifest changes — historical behavior end to end.** The
> implementation is a single ternary: when `paths.base: manifest` is set, the
> resolver and archive layout switch to a manifest-relative base; otherwise they
> use the configured typed dir as before. There is no implicit detection, no
> fallback, no "best guess" — opt in to opt in.

`paths.base` selects which directory typed-key entries (`models`, `vaults`,
`datastores`, `reports`, `include`) and `additionalFiles` resolve against during
push. Two modes:

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
- Workflows honour `paths.base: manifest` — the manifest's own directory is
  searched first, falling back to `workflows/` and `extensions/workflows/` under
  the extensions root and the repo dir.
- Skills honour `paths.base: manifest` — manifest-relative directories are
  searched first, then the extensions root, then project-local. All enrolled
  tools are searched at each level. The global `~/.claude/skills` directory is
  never searched, so a skill is not packaged from a locally installed copy by
  name.

#### Pushing from outside the extension directory

`push`, `quality` and `fmt` accept a manifest file or an extension directory
(`swamp extension push extensions/models/x` means
`extensions/models/x/manifest.yaml`), relative to `--extensions-dir` when set,
then the current directory, then the repo dir. Without `--extensions-dir`, the
extensions root is inferred from the manifest's location (the nearest ancestor
holding `extensions/` or `.swamp.yaml`) when nothing resolves under the repo
dir, so a sub-directory extension in the swamp-extensions layout pushes from a
sibling repo or from its monorepo root without flags. `--extensions-dir` names
the directory that _contains_ `extensions/`; swamp appends `extensions/models`
(and the other typed directories) to it, and the flag covers workflows and
skills too. Without the flag, an entry that exists under both the repo dir and
the inferred root is refused rather than guessed; with the flag, the flag's root
wins. Every not-found error lists the paths it looked in and names the flag or
`paths.base: manifest` as the fix.

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
`swamp extension quality` and `swamp extension push` report the same
`bare-specifiers` warning, naming for each bare name its explicit target from
the `deno.json` import map. Quality still prints the rubric but fails, because
the registry would publish the extension unscored; push warns. The finding
cannot be accepted. Swamp's lint never applies Deno's `no-import-prefix` rule,
so a `deno.json` needs no exclude for the `npm:`/`jsr:` form.

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

See the extension model [examples](../../extension/references/model/examples.md)
for import style examples and helper script details.

### How Content Maps to Manifest

- `models` paths resolve relative to `extensions/models/`
- `vaults` paths resolve relative to `extensions/vaults/`
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

### What the dry run checks

With credentials present, the dry run runs the registry checks a real push runs,
read-only, and reports each one in the `dry_run` document's `registryChecks`
array with the wording the push would fail with:

| Check                   | Passed when                                                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `authentication`        | the stored key is accepted by the registry                                                                                       |
| `reserved-collective`   | `@swamp` / `@si` membership was verified by the registry                                                                         |
| `collective-membership` | the manifest's collective is one of yours                                                                                        |
| `private-entitlement`   | (private intent only) the collective's reported plan allows private extensions: a paid plan, or a free plan with an active trial |
| `version-exists`        | the manifest version is not published on any channel                                                                             |

A `failed` check exits non-zero after the summary. A `not-run` check names the
missing prerequisite in `message` and `cause`: `no-credentials` leaves the run
green, since the registry was never asked; `registry-unavailable` exits
non-zero, since the registry never confirmed what the push needs;
`entitlement-undecided` leaves the run green, since the registry answered but
what it reported does not settle private entitlement (no entitlement reported,
or a free plan with no trial, which the registry may start at publish). The dry
run never prompts and never writes to the registry.

`private-entitlement` fails only for a free plan whose trial has ended, with the
message the push throws:
`Collective "@acme" is on the Free plan and its trial
ended on 2026-08-19. Private publication requires a paid plan; upgrade at
https://swamp-club.com/o/acme/billing.`
A real push the registry refuses on entitlement reports the registry's sentence
followed by what it had reported for the collective at sign-in; it names no plan
the registry did not send.

`apiCalls` lists every HTTP call the run made (registry, OSV, npm) with its
method, URL and outcome; the log summary says "No API calls were made." only
when that list is empty. `contentHash` is the hash the adversarial-review report
path is keyed by. `declaredAcceptances` and `forNextTime` close the document:
what the author accepted, and the paste-ready acceptance for each remaining
warning (see [Declaring acceptances](#declaring-acceptances)).

### Reproducing the CI layout

The content hash labels files by their path relative to the swamp repo dir, so
the same extension hashes differently from a sibling repo. CI publishes from a
swamp repo initialised inside the extension directory. To compute the same hash
locally, run the dry run in that layout:

```bash
cd path/to/extension          # the directory holding manifest.yaml
[ -f .swamp.yaml ] || swamp repo init --quiet --tool none
swamp extension push manifest.yaml --dry-run --json
```

Compare `contentHash` in the output with the hash CI reports. Any byte change in
a packaged file, or a version bump, moves the hash.

### Opportunistic package cache

`swamp extension quality`, `swamp extension push --dry-run`, and
`swamp extension push` all consult a content-hash-keyed cache at
`.swamp/cache/packages/<hash>/`. The hash is derived from the manifest, every
referenced source file, and the deno/package-json configuration — so any source
change invalidates the entry by construction. An entry is reused only by the
swamp version that wrote it, since a reused archive skips the fmt/lint gate; a
cache hit still runs every other gate. Quality writes the cache only when every
gate passed. The cache is a pure optimization: a cache miss falls back to fresh
packaging. The cache is never load-bearing for correctness and can be deleted
safely at any time.

## Version-Drift Check

An advisory (non-blocking) check that runs during `swamp extension push` and
`--dry-run`. It compares current model versions against the last-published
version in the registry to catch a common mistake:

- **Model version bumped, manifest not** — one or more model `version` fields
  changed compared to the published version but the manifest `version` did not.
  The manifest version must be bumped whenever a model version changes so the
  registry reflects that a new release is available.

The check fetches the last-published version's metadata from the registry. This
works on any machine with registry credentials — no local state is required.

When the extension has never been published (first publish), the check reports
that it cannot verify version drift rather than silently skipping. This is
informational, not an error.

The version-drift check is **not** run during `swamp extension fmt` — it
requires registry access that the fmt command does not use.

Manifest and model versions are independent — a multi-model extension can have
each model at a different version. The check never requires model versions to
match the manifest version. It only checks directionality: if a model version
moved, the manifest version must also move.

## Push Workflow

> **Before you push:** Your extension directory must be an initialized swamp
> repository (`.swamp.yaml` must exist). Your extension must also pass
> `swamp extension fmt <manifest> --check`. The push command enforces formatting
> automatically — if your code has formatting or lint issues, the push will be
> rejected. Run `swamp extension fmt <manifest>` to auto-fix before pushing.

### Commands

```bash
# Full push to registry (stable channel, the default)
swamp extension push manifest.yaml --json

# Push to a prerelease channel (beta or rc)
swamp extension push manifest.yaml --channel beta --json

# Validate locally without pushing (builds archive, runs safety checks and
# the registry checks read-only; lists the API calls it made)
swamp extension push manifest.yaml --dry-run --json

# Skip all confirmation prompts
swamp extension push manifest.yaml -y --json

# Specify a different repo directory
swamp extension push manifest.yaml --repo-dir /path/to/repo --json
```

### What Happens During Push

1. **Parse manifest** — validates schema, checks required fields
2. **Registry checks** — authentication, reserved collective, collective
   membership (the manifest's collective is one of yours), private entitlement
   (private intent only: the collective's reported plan allows private
   extensions) and version exists (on any channel). A dry run reports them; a
   push stops at the first failure.
3. **Resolve files** — collects model entry points, auto-resolves local imports,
   resolves workflow dependencies
4. **Detect project config** — walks up from manifest directory to repo root
   looking for `deno.json` (takes priority) then `package.json`. If found and
   the extension uses bare specifiers, it is used for bundling. `deno.json` is
   also used for quality checks, by push, `extension quality` and
   `extension fmt` alike; `package.json` projects use default lint/fmt rules.
5. **Resolve include files** — collects files from the manifest's `include`
   field (if present). These are copied to the archive alongside model sources
   but not bundled or quality-checked.
6. **Safety analysis** — scans all files (including `include` files) for
   disallowed patterns and limits
7. **Quality checks** — runs `deno fmt --check` and `deno lint` on model, vault,
   datastore, and report files (using the project's `deno.json` config if
   present, otherwise default rules). Lint never applies `no-import-prefix`,
   which would forbid the `npm:`/`jsr:` imports swamp requires. Include files
   are excluded.
8. **Bare specifier check** — scans source files for bare import specifiers
   (e.g. `from "zod"` instead of `from "npm:zod@4"`). The server-side scorer
   cannot resolve bare specifiers, so a warning naming each import-map
   replacement is added to the review warnings, prompting the user to confirm
   before push. It cannot be accepted.
9. **Bundle TypeScript** — compiles each entry point (models, vaults,
   datastores) to standalone JS. Include files are not bundled. If a `deno.json`
   is present, the import map governs dependency resolution.
10. **Version-drift check** — advisory check comparing current model versions
    against the last-published version in the registry. Warns when a model
    version was bumped but the manifest `version` was not. If the extension has
    never been published, reports that the check could not run rather than
    silently skipping. See "Version-Drift Check" below.
11. **Version check** — verifies version doesn't already exist (offers to bump)
12. **Build archive** — creates tar.gz with all content types and their bundles
13. **Upload** — three-phase push: initiate, upload archive, confirm

## Extension Formatting

Format and lint extension files before publishing. The `extension fmt` command
resolves all TypeScript files referenced by the manifest (model entry points and
their local imports), then runs `deno fmt` and `deno lint --fix` on them under
the project `deno.json` that push uses (found the same way), or Deno's defaults
when there is none, so `fmt --check` and push give the same verdict.

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
**errors** (block the push) or **warnings** (prompt for confirmation). `--yes`
(or `--force`) answers that prompt along with the push confirmation; the dry-run
and push summaries then list what it waived under `acceptedWarnings`, in log and
JSON output. A warning the author has judged acceptable is better declared where
it is, with a reason, than waived for the run: see
[Declaring acceptances](#declaring-acceptances).

Every finding carries a `ruleId` (the ids below), the `file`, the 1-based `line`
when it has one, a `remediation` (how to fix it properly) and, for a rule that
can be accepted, the exact `acceptance` text to paste.

### Errors (block push)

| Rule                        | Detail                                                                                                                                                                                                                                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eval()` / `new Function()` | Dynamic code execution not allowed in `.ts` files: global `eval` in any form, the `Function` constructor, `.constructor(...)` calls, and members named `eval` or `Function` (`x.eval(...)`). Methods _defined_ with those names, and text in strings, comments and regexes, are fine. The error lists each location as `line:column`. |
| Symlinks                    | Symlinked files are not allowed                                                                                                                                                                                                                                                                                                       |
| Hidden files                | Files starting with `.` are not allowed                                                                                                                                                                                                                                                                                               |
| Disallowed extensions       | Only `.ts`, `.json`, `.md`, `.yaml`, `.yml`, `.txt` in `additionalFiles`. Files in the `binaries` manifest field are exempt — use `binaries` for executables and files with other extensions.                                                                                                                                         |
| File too large              | Individual files must be under 1 MB                                                                                                                                                                                                                                                                                                   |
| Total size exceeded         | All files combined must be under 10 MB                                                                                                                                                                                                                                                                                                |
| Too many files              | Maximum 150 files per extension                                                                                                                                                                                                                                                                                                       |
| Archive too large           | The built `.tar.gz` (after bundling) must be at most 50 MiB — larger archives cannot be installed                                                                                                                                                                                                                                     |

### Warnings (prompted)

One finding per offending line, so each can be accepted on its own.

| Rule id                 | Detail                                                              |
| ----------------------- | ------------------------------------------------------------------- |
| `deno-command`          | `Deno.Command(` on the line (subprocess spawning)                   |
| `long-line`             | A line with 500+ non-whitespace characters                          |
| `base64-run`            | A line with a run of 100+ base64 characters                         |
| `ipv4-address-literals` | An IPv4 literal in `.md` or `.txt` outside the documentation ranges |

The review rules (`credentials-sensitive-field`, `schema-strictness`,
`testing-completeness`) and the extension-scoped `bare-specifiers` finding are
warnings too. `bare-specifiers` cannot be accepted: the registry cannot score
the extension however it is justified, and the fix is to write each import's
`npm:`/`jsr:` target. `testing-completeness` reports once per extension when
more than one entry point has no sibling `_test.ts`, naming the files. The
`adversarial-review-report` family is evidence, not a lint, and has no
acceptance form.

Error-level rule ids (`dynamic-code`, `hidden-file`, `file-type`, `symlink`,
`file-size`, `total-size`, `file-count`, `unreadable-file`, `fmt`, `lint`,
`dynamic-import`, `upgrade-chain`) can never be accepted.

## Declaring acceptances

An acceptance is a reasoned judgement that one warning-level finding is
acceptable for this extension. It lives where the finding is, like a lint
ignore, is reviewed in the pull request with the code, and is reported in
`quality`, in the push summary and `--json`, and to the registry. Push writes
nothing: the summaries print the exact text to paste.

**Site-scoped rules** (`credentials-sensitive-field`, `schema-strictness`,
`deno-command`, `base64-run`, `long-line`, `ipv4-address-literals`) take a
comment on the finding's line, or on the line directly above (one blank line in
between is allowed; several directives may stack), with a required reason.
Directive text inside a fenced code block or a `/* ... */` block is
documentation and is ignored:

```typescript
apiKey: z.string(), // swamp-quality-ignore credentials-sensitive-field: holds the name of a vault key
```

In Markdown the comment is an HTML comment on the line above:

```markdown
<!-- swamp-quality-ignore ipv4-address-literals: documented lab gateway -->

Gateway: 10.0.0.1
```

**File-scoped** `testing-completeness` takes the same comment anywhere in the
file (the top is conventional):

```typescript
// swamp-quality-ignore testing-completeness: thin wrapper covered by the integration suite
```

A site rule in a `.txt` file (which has no comment form) and the `generated`
declaration for a codegen package live in a `quality.yaml` sidecar beside
`manifest.yaml`. It is discovered by location, never named in the manifest (most
manifests are regenerated), packaged into the archive root beside
`manifest.yaml`, and part of the content hash:

```yaml
version: 1
generated: # a codegen package: accepts testing-completeness for every model
  by: swamp-extensions/codegen
  source: https://api.example.com/openapi.yaml
  commit: 0123abcd
accept:
  - rule: ipv4-address-literals
    file: docs/hosts.txt
    reason: documented lab addresses
```

Rules, enforced by construction:

- An acceptance names one finding by file, rule and line. A new match elsewhere
  still warns. The sidecar refuses site-scoped rules except for `.txt` files,
  and refuses files outside the manifest's directory.
- A comment with no reason, with the `<reason>` placeholder still in place,
  naming an unknown, error-level or otherwise non-acceptable rule
  (`bare-specifiers`, the `adversarial-review-report` family), or more than 50
  per file, is a blocking `invalid-acceptance` error naming the comment. Reasons
  are capped at 200 characters, and in source files may not contain a quote
  character, `Deno.Command(` or a base64 run: the safety checks scan every line
  as written, so a directive can never trigger or hide a finding.
- An acceptance whose rule no longer fires there is a `stale-acceptance` warning
  at the comment, so acceptances do not accumulate.
- A malformed `quality.yaml` blocks the push before any gate runs, like a
  malformed manifest.

**Reporting.** The dry-run and completed push summaries, and
`swamp extension quality`, end with two blocks: `Accepted, with reasons:` (each
declared acceptance, and the generated declaration) and `For next time:` (each
unaccepted warning with how to fix it and, when the rule can be accepted, the
exact comment or sidecar entry to paste and where it goes). In `--json` they are
`declaredAcceptances` (`{ accepted: [...], generated? }`) and `forNextTime`
(`[{ ruleId, file, line?, message, remediation?, acceptance?, placement? }]`),
beside `acceptedWarnings` and omitted when empty; every finding in
`reviewRuleWarnings` and `warnings` carries `acceptance` and `remediation`. The
acceptances also travel to the registry in `contentMetadata.acceptances`.

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

| Error                             | Fix                                                                                                                                |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| "Not a swamp repository"          | Run `swamp repo init --json` in the extension directory                                                                            |
| "Not authenticated"               | Run `swamp auth login` first                                                                                                       |
| "collective does not match"       | Manifest `name` must use `@your-username/...`                                                                                      |
| "CalVer format" error             | Use `YYYY.MM.DD.MICRO` (e.g., `2026.02.26.1`)                                                                                      |
| "at least one model, workflow…"   | Add a `models`, `workflows`, `vaults`, `datastores`, or `skills` array                                                             |
| "Model file not found"            | Check path is relative to `extensions/models/`                                                                                     |
| "Workflow file not found"         | Check path is relative to `workflows/`                                                                                             |
| "would both be packaged as"       | Two workflow entries map to one archive file name; rename one file, or move it into its own directory                              |
| "is listed twice in the manifest" | The same workflow file appears twice in `workflows`; remove one entry                                                              |
| "eval() or new Function()"        | Remove dynamic code at the listed `line:column` locations; rename a method called as `x.eval(...)`, or import the library from npm |
| "Version already exists"          | Bump the MICRO component or let CLI auto-bump                                                                                      |
| "Missing manifestVersion"         | Add `manifestVersion: 1` to your manifest                                                                                          |
| "Bundle compilation failed"       | Fix TypeScript errors in your model files                                                                                          |
| "Extension is already deprecated" | Already deprecated — use `undeprecate` first if re-deprecating with new reason                                                     |
| "Extension is not deprecated"     | Nothing to undeprecate — extension is not currently deprecated                                                                     |

## Related Skills

| Need                               | Use Skill                 |
| ---------------------------------- | ------------------------- |
| Create custom models               | `swamp-extension`         |
| Create custom vaults               | `swamp-extension`         |
| Create custom datastores           | `swamp-extension`         |
| Repository setup and management    | `swamp-repo`              |
| Create reports                     | `swamp-report`            |
| Quality scorecard & best practices | `swamp-extension`         |
| Deprecate/undeprecate extensions   | `swamp-extension-publish` |

## Quality Self-Check

Run between formatting (State 6) and dry-run (State 7):

```bash
swamp extension quality manifest.yaml --json
```

Scores the extension against the 10 client-earnable Swamp Club quality factors
(README, LICENSE, JSDoc coverage, repository URL, manifest completeness,
slow-type diagnostics, etc.) and prints per-factor results with remediation
hints. It runs the same gates push runs; when one fails (safety, fmt/lint,
collectives, upgrade chain, dependency trust, review errors, size) it still
prints the rubric, then each failure with its details, and exits non-zero
(`gateFailures` in `--json`; `excludedFromArchive` lists files a check rejected
and left out of the scored archive). `registryScorable: false` means the
registry would publish the extension unscored. When every gate passes, the
packaged tarball is written to `.swamp/cache/packages/<hash>/` and reused by
dry-run and push while the source tree and swamp version are unchanged.

This step is optional — skipping does not block the push. See the
`swamp-extension` skill for the full rubric and per-factor guidance.
