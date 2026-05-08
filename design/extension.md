# Extensions

An extension in swamp is a distributable package of models, workflows, vaults,
drivers, datastores, and reports that can be shared through a registry.
Extensions allow the community to share reusable automation components that
others can pull into their repositories.

## Name

Every extension has a scoped name in the format `@collective/name`. The collective
identifies the collective, and the name identifies the extension. Additional
path segments are allowed for organizing related extensions hierarchically.
All parts must be lowercase and may contain alphanumeric characters, hyphens,
and underscores. The pattern is `@[a-z0-9_-]+/[a-z0-9_-]+(/[a-z0-9_-]+)*`.

The collectives `@swamp` and `@si` are reserved for built-in extensions and
cannot be used by external authors.

You cannot use another person's name in the extensions that you publish.

Examples: `@keeb/ssh`, `@acme/deploy`, `@myorg/aws-helpers`, `@swamp/aws/ec2`,
`@swamp/aws/accessanalyzer/analyzer`.

## Version

Extensions use **CalVer** format `YYYY.MM.DD.MICRO` (e.g., `2026.02.26.1`).
The micro counter allows multiple versions per day and resets for each new date.
This is the same versioning scheme used by models (see [./models.md]).

The registry enforces unique name+version tuples. If a version conflict occurs
during push, the CLI offers to bump the version automatically.

Use `swamp extension version <name>` to query the registry for the latest
published version and compute the next CalVer version. Accepts an extension
name directly or `--manifest <path>` to read the name from a manifest file.
Does not require a swamp repository — works from any directory.

## Freshness

Two opt-in user-facing surfaces report whether installed extensions are
behind the registry's latest version. There is no passive on-load
warning — extension freshness is surfaced only when the user explicitly
asks for it.

### `swamp extension list`

Augments the installed-extensions table with a "latest" column when
stdout is a terminal. Outdated rows are marked `(update available)`;
rows where the registry could not be reached are marked
`(offline — last check failed)`. Two flags control the behavior:

- `--check-updates` forces enrichment on regardless of stdout type
  (useful in CI when the user explicitly wants the side-by-side view
  in JSON output).
- `--no-check-updates` forces enrichment off.

Default behavior: enrichment runs when stdout is a terminal AND output
mode is `log`. JSON output and piped invocations skip enrichment by
default to keep scripted use of `extension list` cheap and offline.

JSON output: when enrichment ran, each entry carries optional
`latestVersion` and `updateStatus` fields. `updateStatus` is one of
`up_to_date`, `update_available`, or `unknown_offline`. Consumers can
distinguish "didn't try" (fields absent) from "tried and failed"
(`updateStatus: "unknown_offline"`, `latestVersion: null`).

### `swamp extension outdated`

A dedicated subcommand intended for CI gates and scheduled checks.
Renders all non-up_to_date statuses (update_available, not_found,
failed) so users see them, but the EXIT CODE depends only on
update_available presence:

- Exit 1 if at least one extension has status `update_available`.
- Exit 0 otherwise (including when only `not_found` or `failed` are
  present).

This deliberate semantic means a CI gate
`swamp extension outdated && deploy` fails only on a clear
newer-version-exists signal, not on transient registry errors. The
exit-code semantic is a public contract: broadening it later (to also
fail on not_found/failed) would silently break pipelines built on the
strict semantic.

### Cache and registry behavior

Both surfaces share a 24-hour on-disk cache stored at
`.swamp/extension-update-checks.json`. The TTL matches the
`CHECK_INTERVAL_MS` constant in `src/domain/update/update_check_cache.ts`
already used by datastore auto-update. Within the 24h window,
freshness data is served from cache without contacting the registry.

On registry failure for a stale entry, the cache is stamped with
`latestVersion: installedVersion` to suppress retries for the next
24h. This is a deliberate trade-off: during that 24h window, a
stamped entry will read as `up_to_date` even though the latest
version is genuinely unknown — the alternative (every command
hammering an unreachable registry) is worse for advisory data. The
in-memory enriched entry returned by the list composer additionally
carries `updateStatus: "unknown_offline"` so the user can distinguish
"freshly failed" from "cache-fresh up_to_date" within the same
invocation. After 24h, the cache entry expires and the next command
re-attempts the registry call.

The cache file itself is written atomically via `atomicWriteTextFile`,
so concurrent writers cannot corrupt the file. The repository uses
read-modify-write on the whole map, so under parallel invocations one
writer's individual mutations may be lost (last-writer-wins on the
whole map). For a 24h advisory cache where each entry is
self-contained, lost mutations simply re-occur on the next stale
check — never file corruption. A per-extension keyed file or kvstore
would eliminate the trade-off and is a future improvement.

### Why no passive on-load warning

The original feature request (issue #199) proposed a per-extension
warning emitted on every command that resolves an extension bundle.
After research into how comparable tools handle this, swamp ships
the explicit-only design instead:

- Terraform, OpenTofu, and Ansible all explicitly chose against
  passive nags for plugin/provider staleness, treating it as user
  opt-in. OpenTofu re-litigated the design (issue #2032, closed
  not-planned) citing CI-breakage concerns.
- Pulumi ships a passive nag (for the CLI itself, not plugins) and
  has documented user pain at length: per-invocation noise (issue
  #5576), wrong severity level (issue #10578), unactionable warnings
  when package managers haven't caught up (issue #2426).
- No surveyed tool has shipped a generally-loved per-extension
  passive warning. gh's extension version checker is the closest
  attempt and is the documented cautionary tale (issue #10235:
  blocking PostRun call hangs commands for minutes).

If real demand for a passive surface emerges, the path forward is
documented but not implemented: an end-of-command, single-line,
aggregated, info-level (not warn) advisory with 24h display
cooldown, TTY gating, env-var suppression
(`SWAMP_NO_UPDATE_NOTIFIER`), and non-blocking time-budgeted
registry calls. Per-extension warnings at the start of every command
are explicitly out.

## Manifest

Every extension is defined by a `manifest.yaml` file. The manifest declares
what the extension contains and how it should be packaged.

### Required Fields

- `manifestVersion`: Must be `1` (the only supported version).
- `name`: Scoped name (`@collective/name`).
- `version`: CalVer version string.
- At least one of `models`, `workflows`, `vaults`, `drivers`, `datastores`,
  `reports`, or `skills` must be present.

### Path Safety

All file paths in the manifest must be **relative and downward-only**. Paths
containing `..` components (e.g., `../../workflows/file.yaml`) or starting with
`/` (absolute paths) are rejected during push. This prevents archive entries
that would fail the pull-side safety validator, which rejects any tar entry
containing `..` or starting with `/`.

### Optional Fields

- `description`: Human-readable description of the extension.
- `paths.base`: Path resolution mode for the typed keys below. `"typedDir"`
  (default) resolves typed entries relative to their configured directory
  (`modelsDir`, `vaultsDir`, etc.). `"manifest"` resolves every typed entry
  plus `additionalFiles` relative to the manifest's own directory — pick
  this for per-extension-subdir layouts where manifest, source, README,
  and LICENSE all sit alongside each other. See "Path resolution" below.
- `models`: Array of relative paths to TypeScript model files (e.g.,
  `["aws/ec2/instance.ts"]`). Resolved via `paths.base`.
- `workflows`: Array of relative paths to YAML workflow files. Workflows
  use a multi-base lookup (indexer dir then extension workflows dir) and
  are not affected by `paths.base`.
- `vaults`: Array of relative paths to TypeScript vault files. Resolved
  via `paths.base`.
- `drivers`: Array of relative paths to TypeScript driver files. Resolved
  via `paths.base`.
- `datastores`: Array of relative paths to TypeScript datastore files.
  Resolved via `paths.base`.
- `reports`: Array of relative paths to TypeScript report files. Resolved
  via `paths.base`.
- `skills`: Array of skill directory names resolved from the tool's skill
  directory (e.g., `.claude/skills/`). Each directory must contain a `SKILL.md`
  with YAML frontmatter declaring `name` and `description`. Skills are passive
  markdown guidance documents — swamp never executes them. Skills are not
  affected by `paths.base`.
- `include`: Array of relative paths to TypeScript files that should be
  included in the archive alongside models but not bundled. Used for
  helper scripts that are executed via `Deno.Command` subprocess rather
  than imported directly. Resolved via `paths.base`.
- `additionalFiles`: Array of relative paths to non-model files (README,
  config, etc.). Always resolved relative to the manifest's own directory.
- `platforms`: Array of platform identifiers the extension supports (e.g.,
  `["darwin-aarch64", "linux-x86_64"]`). Informational only — displayed during
  pull.
- `tags`: Array of categorization labels (e.g., `["aws", "kubernetes"]`).
- `dependencies`: Array of extension names (`@collective/name`) that this
  extension requires. Dependencies are pulled automatically.

### Example

```yaml
manifestVersion: 1
name: "@keeb/ssh"
version: "2026.02.26.1"
description: "SSH connection management for swamp"
models:
  - ssh/connection.ts
workflows:
  - ssh-check.yaml
reports:
  - cost-summary.ts
additionalFiles:
  - ssh/known_hosts_template.txt
dependencies:
  - "@keeb/network"
platforms:
  - darwin-aarch64
  - linux-x86_64
tags:
  - ssh
  - networking
```

### Path Resolution

The `paths.base` field selects the directory typed-key entries
(`models`, `vaults`, `drivers`, `datastores`, `reports`, `include`) plus
`additionalFiles` resolve against during push. Two modes:

- **`typedDir` (default)** — typed entries resolve relative to their
  configured directory from the repo marker (`modelsDir`, `vaultsDir`,
  etc., or environment overrides like `SWAMP_MODELS_DIR`).
  `additionalFiles` resolves relative to the manifest's own directory.
  This is the historical behavior; every existing manifest without an
  explicit `paths.base` keeps these semantics.
- **`manifest`** — every typed entry plus `additionalFiles` resolves
  relative to the manifest's own directory. Pick this for
  per-extension-subdir layouts where manifest, source, README, and
  LICENSE all live alongside each other (e.g.
  `extensions/models/myext/manifest.yaml` next to `myext/echo.ts` and
  `myext/README.md`).

Workflows and skills keep their bespoke multi-base lookup (workflows
fall back from the indexer dir to the extension workflows dir; skills
look up project-local then global). `paths.base` does not apply to
those keys.

The on-wire manifest in the archive preserves the field strings
verbatim — no path rewriting, no normalization. WYSIWYG between what
the author pushes and what the registry stores. The archive layout
under each typed-key directory mirrors the entry strings: under
`paths.base: manifest` with `models: [echo.ts]`, the archive contains
`extension/models/echo.ts` directly.

## Archive Structure

When pushed, an extension is packaged as a gzipped tar archive with the
following structure:

```
extension.tar.gz
└── extension/
    ├── manifest.yaml
    ├── models/              # Source TypeScript model files
    │   └── ssh/
    │       ├── connection.ts
    │       └── helpers.ts
    ├── bundles/              # Compiled model JavaScript bundles
    │   └── ssh/
    │       └── connection.js
    ├── workflows/            # YAML workflow files
    │   └── ssh-check.yaml
    ├── vaults/               # Source TypeScript vault files
    ├── vault-bundles/        # Compiled vault JavaScript bundles
    ├── drivers/              # Source TypeScript driver files
    ├── driver-bundles/       # Compiled driver JavaScript bundles
    ├── datastores/           # Source TypeScript datastore files
    ├── datastore-bundles/    # Compiled datastore JavaScript bundles
    ├── reports/              # Source TypeScript report files
    ├── report-bundles/       # Compiled report JavaScript bundles
    └── files/                # Additional files
```

### Models

Source TypeScript files are included preserving their relative directory
structure from the active base (the configured `modelsDir` under
`paths.base: typedDir`, the manifest's own directory under
`paths.base: manifest`). Local imports are resolved recursively — if
`connection.ts` imports `./helpers.ts`, both files are included.

Files listed in the manifest's `include` field are also copied to `models/` in
the archive, preserving their relative paths from the active base. Include
files are not bundled — they are raw TypeScript files intended to be executed
as subprocesses or used as standalone utilities.

### Loader pre-check

At runtime, loaders discover `.ts` files in their respective directories and
attempt to bundle each one. Before bundling, the loader reads the source and
checks for the expected named export (`export const model`, `export const vault`,
etc.). Files that don't declare the expected export are skipped — no bundling
attempted, no error. This avoids failing on helper scripts with unbundleable
dependencies (e.g., native modules used via `Deno.Command` subprocess).

### Bundles

Each model entry point is compiled using `deno bundle` with zod externalized.
All other non-local specifiers (`npm:`, `jsr:`, `https:`) are resolved and
inlined into the bundle, which ensures they work in the compiled binary where
only swamp's own embedded dependency graph is available. Zod is externalized so
extensions share the same zod instance as swamp (required for schema
`instanceof` checks). Dynamic `import()` calls are not supported — all imports
must be static top-level imports. Bundles are JavaScript files stored alongside
their source counterparts under `bundles/`.

**First-class specifier kinds:** `npm:`, `jsr:`, and `https:` are peers —
`deno bundle` resolves all three natively with identical treatment (all
inlined, all cached by Deno's module cache, all subject to the same
externalization rules for zod). No per-specifier-kind configuration is required.

**Pin versions on all non-local specifiers** (`npm:`, `jsr:`, `https:`) for
reproducibility. An unpinned specifier resolves to the registry's current
"latest" at push time, which means the published bundle silently changes
whenever the upstream package publishes a new version. See
`.claude/skills/swamp-extension-publish/references/publishing.md` for
author-facing guidance.

#### Project-aware bundling

Extensions can optionally live within a project that has a `deno.json` or
`package.json`. When `swamp extension push` is run, it walks up from the
manifest directory to the repo root looking for project config files.

**Detection priority:** `deno.json` is searched first (full walk from manifest
to repo root). Only if no `deno.json` is found does the push command walk again
looking for `package.json`. This means `deno.json` always wins regardless of
directory depth.

**Bare specifier gate:** A `package.json` is only used when the extension source
actually contains bare specifiers (e.g., `from "zod"` instead of
`from "npm:zod@4"`). This prevents an unrelated `package.json` (e.g., one
containing `@anthropic-ai/claude-code` for tooling) from being mistakenly
treated as the extension's project config.

#### Bundling permutations

| Scenario | `deno bundle` flags | Quality check flags | Notes |
|----------|-------------------|-------------------|-------|
| **`deno.json` found** | `--config <deno.json>` | `--config <deno.json>` | Import map governs resolution; project lint/fmt rules apply |
| **`package.json` found, bare specifiers** | `--node-modules-dir=auto`, `cwd` set to package.json dir | `--no-config` | Deno auto-detects package.json; `node_modules/` must exist from `npm install` or `deno install`; `--node-modules-dir=auto` initializes `.deno/` metadata if needed |
| **`package.json` found, `npm:` imports** | `--no-lock --node-modules-dir=none` | `--no-config` | Package.json is ignored (extension doesn't need it); `--node-modules-dir=none` prevents ambient package.json from poisoning resolution |
| **No config found** | `--no-lock --node-modules-dir=none` | `--no-config` | Default behavior; `--node-modules-dir=none` prevents any package.json in the directory tree from interfering |

The `--node-modules-dir=none` flag is critical for the last two cases: without
it, an unrelated `package.json` anywhere in the directory tree causes Deno to
switch to `node_modules/` resolution mode, breaking `npm:` prefixed imports with
errors like "Could not find a matching package for 'npm:@octokit/rest@22.0.1'
in the node_modules directory."

`jsr:` and `https:` specifiers work identically across all four rows — they
don't require `deno.json` or `package.json` to resolve, so the project-config
detection logic is irrelevant to them. They are fetched and cached by Deno's
module cache on first use and reused offline thereafter.

#### Zod externalization

Zod is externalized using `--external` flags that match the specifier as
written in source. The bundler handles:

- `npm:zod@4` and `npm:zod` (base patterns, always applied)
- Fully-pinned versions like `npm:zod@4.3.6` (detected by scanning the source)
- Bare `"zod"` specifier via `deno.json` (when the import map maps it to
  zod 4.x, both the resolved specifier and bare `"zod"` are externalized)
- Bare `"zod"` specifier via `package.json` (when `dependencies` or
  `devDependencies` lists zod 4.x)

After bundling, `rewriteZodImports` rewrites any externalized zod import to
`globalThis.__swamp_zod`, which is set at runtime by `installZodGlobal()`. The
rewrite regex matches both `npm:zod@4.x` and bare `"zod"` specifiers, but
explicitly excludes zod 3.x to prevent silent runtime breakage.

#### Runtime bundle caching

At runtime, loaders check `.swamp/bundles/` (or the corresponding `-bundles/`
directory) for cached bundles. If the source file contains bare specifiers that
require a project config to resolve, and a cached bundle exists, the loader uses
the cached bundle rather than attempting a re-bundle that would fail without the
config. This supports pulled extensions that were built with a `deno.json` or
`package.json` project — the archive includes pre-built bundles but not the
project config.

When a non-filesystem datastore is configured (e.g. `@swamp/s3-datastore`),
bundle paths are resolved through the `DatastorePathResolver` instead of the
hardcoded local `.swamp/` directory. This routes bundle reads and writes to the
datastore cache path (e.g. `~/.swamp/repos/<repo-id>/bundles/`). The datastore
loader is excluded from this routing due to bootstrap ordering — it always uses
the local path since it loads datastore extensions that configure the resolver
itself. When no resolver is available (e.g. during `repo init` or in tests),
loaders fall back to the local `.swamp/` path.

### Vaults, Drivers, Datastores, and Reports

Vault, driver, datastore, and report entry points are bundled with the same
strategy as models — deno bundle with zod externalized. Each entry point gets a
compiled `.js` file in its corresponding `-bundles/` directory
(`vault-bundles/`, `driver-bundles/`, `datastore-bundles/`,
`report-bundles/`). Local imports are resolved recursively within the directory
boundary.

The export from each bundle is validated against a Zod schema:

- **Vaults**: `export const vault` — must have `type`, `name`, `description`,
  optional `configSchema`, and `createProvider`
- **Drivers**: `export const driver` — must have `type`, `name`, `description`,
  optional `configSchema`, and `createDriver`
- **Datastores**: `export const datastore` — must have `type`, `name`,
  `description`, optional `configSchema`, and `createProvider`
- **Reports**: `export const report` — must have `name`, `description`,
  `scope`, optional `labels`, and `execute`

### Collective Validation

All content types — model types, vault types, workflow names, driver types,
datastore types, report names — must use the same collective as the extension
name. This is enforced during push to prevent an extension from registering
types under a different collective.

### Workflows

Workflow YAML files are included with unique archive names derived from their
directory path to avoid collisions.

### Additional Files

Files listed in `additionalFiles` are included under the `files/` directory
preserving their relative paths. A manifest entry `prompts/review.md` lands
at `files/prompts/review.md` in the archive; pulled consumers find it at
`.swamp/pulled-extensions/<name>/files/prompts/review.md`.

Push rejects:

- Duplicate entries (case-insensitive, NFC-normalized) — two entries that
  would resolve to the same archive path fail with a clear error naming
  both offenders.
- Symlinks — to prevent archive bloat and path escapes, entries pointing
  at symlinks are rejected. Copy the target file into the extension tree
  instead.

### Runtime access

Model method `execute` functions and report functions receive a context
with an `extensionFile(relPath)` helper that resolves a relative path
from `additionalFiles` to an absolute filesystem path. The helper
abstracts the source-vs-pulled layout divergence — the same code works
whether the extension was added via `swamp extension source add` (files
resolve relative to the manifest) or pulled from the registry (files
resolve under `.swamp/pulled-extensions/<name>/files/`).

```ts
export const model = {
  type: "@org/ext/demo",
  version: "2026.04.22.1",
  methods: {
    run: {
      arguments: z.object({}),
      execute: async (_args, ctx) => {
        const path = ctx.extensionFile("prompts/review.md");
        const prompt = await Deno.readTextFile(path);
        // ...
      },
    },
  },
};
```

The helper throws a typed `UserError` when the path is unsafe (contains
`..`, starts with `/`), when the file is missing, or when called on a
model that isn't shipped via an extension manifest. The missing-file
error is mode-aware: pulled-mode archives get a re-publish hint;
source-mode callers get the absolute path and a pointer at the manifest
entry.

## Import Resolution

When packaging an extension, the CLI resolves all local TypeScript imports
starting from each entry point (model, vault, driver, datastore, or report).
The resolver follows relative `import`/`export` statements (e.g.,
`./helpers.ts`, `../shared.ts`) and includes all transitively imported files.
Only files within the respective directory boundary are included. Non-local
imports (`npm:`, `jsr:`, `https:`) are skipped here — they are resolved and
inlined at bundle time by `deno bundle`, not by the local-import resolver.

## Dependencies

Extensions can declare dependencies on other extensions. During a pull,
dependencies are resolved and pulled automatically if not already installed.

### Dependency Resolution

- Dependencies are listed by scoped name in the manifest (e.g.,
  `@keeb/network`).
- When pulling, each dependency is checked against `upstream_extensions.json`.
  If not already installed, it is pulled recursively.
- Maximum recursion depth is 10 to prevent circular dependency loops.
- A `alreadyPulled` set tracks extensions visited in a single pull session to
  avoid duplicate work.

### Workflow Dependency Resolution

During push, the CLI also resolves which models a workflow references. It
parses workflow YAML to find `model_method` and `workflow` step tasks, then
looks up the corresponding model source files. Only user-collective models
(types starting with `@`) are bundled — built-in models are skipped.

## Automatic Resolution

Extensions from trusted collectives auto-resolve on first use — no manual
`extension pull` needed. When swamp encounters an unknown model type from a
trusted collective, it searches the registry, installs the extension, hot-loads
it, and continues.

### Trusted Collectives

The `swamp` and `si` collectives are trusted by default. Extensions from
`@swamp/*` and `@si/*` auto-resolve with no configuration required.

Default trusted collectives: `["swamp", "si"]`.

Additionally, collectives the user belongs to are automatically trusted. Membership
collectives are cached in `auth.json` during `auth login` and `auth whoami`, and
merged with the explicit list at CLI startup. This means if a user is a member of
`@myorg`, extensions from `@myorg/*` auto-resolve without any configuration.

Configurable via `trustedCollectives` in `.swamp.yaml`:

```yaml
trustedCollectives:
  - swamp
  - si
  - myorg
```

Set `trustMemberCollectives: false` to disable membership-based trust and only
use the explicit `trustedCollectives` list. Set `trustedCollectives` to `[]` and
`trustMemberCollectives: false` to disable automatic resolution entirely.

#### CLI Management

Trusted collectives can be managed via the `swamp extension trust` commands:

```bash
swamp extension trust list                # Show explicit, membership, and resolved collectives
swamp extension trust add <collective>    # Add a collective to the trusted list
swamp extension trust rm <collective>     # Remove a collective from the trusted list
swamp extension trust auto-trust <on|off> # Enable/disable membership auto-trust
```

### Resolution Algorithm

1. **Local registry** — check if the type is already registered locally.
2. **Direct lookup** — strip trailing path segments from the type to derive the
   extension name (e.g., `@swamp/aws/ec2/instance` → `@swamp/aws/ec2` →
   `@swamp/aws`) and look up each candidate directly in the registry.
3. **Search fallback** — if direct lookup fails, search the registry for
   matching extensions.

### Safety: never overwrite on-disk extensions

Auto-resolution will never overwrite an extension that is already installed
on disk. If the type failed to register despite the extension being present,
something is wrong locally (commonly a user's in-progress edit introducing
a syntax error) and a silent force-pull would destroy that work.

The resolver inspects the pulled tree and classifies it into one of three
states, driving the auto-resolve decision:

- **Missing** — no entry in `upstream_extensions.json`, or the
  per-extension directory under `.swamp/pulled-extensions/<name>/` is
  absent. A clean install proceeds.
- **Intact** — the lockfile entry exists, the directory exists, and
  every file the lockfile lists for this extension is present on disk.
  If the type still failed to register, the cause is local. The resolver
  surfaces `alreadyInstalledButFailed` with the install path and the
  `--force` recovery command.
- **Truncated** — the lockfile entry and directory both exist, but one
  or more files the lockfile lists are missing from disk
  (swamp-club#133). This is the "present but incomplete" state that
  used to produce misleading `Unknown <kind> type` errors downstream.
  The resolver now surfaces `alreadyInstalledTruncated` naming the
  missing files, exits with an error, and does **not** attempt to
  repair. In JSON mode the event shape is:
  ```json
  {"event":"auto_resolve","status":"failed","extension":"...","path":"...","reason":"truncated","missing":["..."]}
  ```

Both "intact-but-fails" and "truncated" surface the same
`swamp extension pull <name> --force` recovery — that command is the
only way auto-installation state can overwrite a pulled extension. No
other auto-resolve, validate, or run command will ever clobber local
edits or silently re-fetch a broken tree.

The truncation predicate is file-level: any file listed in the lockfile
entry for an extension that cannot be stat'd on disk. The check stops
at presence — it does not verify file contents, only that the paths the
lockfile says should exist actually do.

Paths under `.swamp/bundles/`, `.swamp/vault-bundles/`,
`.swamp/driver-bundles/`, `.swamp/datastore-bundles/`, and
`.swamp/report-bundles/` are excluded from this check. Those are
regenerable build artifacts: clearing the bundle cache is a normal
hygiene operation and must not flip an extension with intact source
into the truncated branch (which would steal the user-WIP path from
issue #121). Only source-tree files — the per-extension subtree under
`.swamp/pulled-extensions/<name>/` — drive truncation.

### Hot-Loading

After installation, swamp re-runs model and vault discovery with
`skipAlreadyRegistered` to load only the newly installed types. This avoids
re-registering types that were already loaded at startup.

User extensions under `extensions/models/` that `extend` a newly-installed
base type are also re-attached during hot-loading. The installer walks
catalog-recorded extension rows and calls the extension-attach primitive
for each base that is now fully registered, so a user extension targeting
`@swamp/aws/ec2/instance` becomes callable as soon as auto-resolve pulls
`@swamp/aws` — no separate command needed.

### Re-Entrancy Guard

A guard prevents infinite loops — if auto-resolution is already in progress for
a type, subsequent resolution attempts for that type are skipped.

### Architecture

`ExtensionAutoResolver` is a domain service with port interfaces. Adapters in
the CLI layer provide the concrete implementations for registry access, extension
installation, and model/vault discovery.

### Output

Auto-resolution always shows status messages to the user: searching for the
extension, installing it, and confirming installation with the number of models
loaded.

## Safety

All TypeScript files in an extension are analyzed for safety before push and
after pull.

### Hard Errors (block push/pull)

- Hidden files (names starting with `.`)
- Disallowed file extensions (only `.ts`, `.json`, `.md`, `.yaml`, `.yml`,
  `.txt` are allowed)
- Symlinks
- Individual file size exceeding 1 MB
- Total extension size exceeding 10 MB
- File count exceeding 150
- Use of `eval()` or `new Function()` (code injection)

### Warnings (prompt user)

- Lines with more than 500 non-whitespace characters
- Base64-like strings (100+ consecutive base64 characters)
- Use of `Deno.Command()` for subprocess spawning

### Integrity Verification

Archives are verified using SHA-256 checksums. The checksum is computed at push
time and stored in the registry. During pull, the downloaded archive's checksum
is verified against the registry. Legacy extensions that predate checksum
support are marked as "unverified" but still allowed.

## Registry

Extensions are distributed through the swamp registry at `https://swamp-club.com`.

### Authentication

Push operations require authentication via an API key (Bearer token). Pull
operations are unauthenticated. Users can only push extensions to their own
collective. You need to authenticate to Swamp Club via the CLI `swamp auth login`
to get the correct API Key used for push.

### Push Protocol

Push uses a three-phase protocol:

1. **Initiate**: `POST /api/v1/extensions/push` — declares intent, receives a
   presigned S3 upload URL.
2. **Upload**: `PUT {uploadUrl}` — uploads the tar.gz archive directly to S3.
3. **Confirm**: `POST /api/v1/extensions/confirm` — finalizes the version in
   the registry.

### Pull Protocol

1. **Resolve**: `GET /api/v1/extensions/{name}` — get metadata and latest
   version.
2. **Download**: `GET /api/v1/extensions/{name}@{version}/download` — follows a
   302 redirect to download the archive.
3. **Verify**: `GET /api/v1/extensions/{name}@{version}/checksum` — retrieve
   the SHA-256 checksum for integrity verification.

## Upstream Extensions Tracking

When an extension is pulled, its metadata and the list of extracted files are
recorded in `upstream_extensions.json` in the models directory. This file
enables clean removal, conflict detection, and **integrity-anchored restore**
(see `checksum` field below).

### Structure

```json
{
  "@keeb/ssh": {
    "version": "2026.02.26.1",
    "pulledAt": "2026-02-27T10:30:00.000Z",
    "checksum": "sha256-…",
    "files": [
      ".swamp/pulled-extensions/@keeb/ssh/models/ssh/connection.ts",
      ".swamp/pulled-extensions/@keeb/ssh/models/ssh/helpers.ts",
      ".swamp/pulled-extensions/@keeb/ssh/workflows/ssh-check.yaml",
      ".swamp/pulled-extensions/@keeb/ssh/manifest.yaml",
      ".swamp/bundles/<hash>/ssh/connection.js"
    ]
  }
}
```

### Integrity Anchor

Every lockfile entry records the SHA-256 of the extension archive at install
time (`checksum`). On any lockfile-restore flow (`swamp extension install`,
phase-two migration re-pull), the freshly-downloaded archive is verified
byte-for-byte against this stored value. On mismatch, the restore fails
loudly with a message offering the user a choice: accept current registry
content (`swamp extension pull <name>`) or pin an older version. This turns
the lockfile into an integrity manifest rather than just a version record —
restores cannot silently accept drifted registry bytes. Entries predating
checksum tracking (pre-commit `f4dfc083`) skip verification gracefully.

Explicit `swamp extension pull <name>` is the user's opt-in path to accept
whatever bytes the registry currently serves; integrity verification is
scoped strictly to lockfile-restore flows.

### Concurrency Safety

All mutations to `upstream_extensions.json` use an advisory lockfile
(`upstream_extensions.json.lock`) with retry logic (10 attempts, 100ms backoff)
and atomic file writes to prevent corruption from concurrent operations.

## File Extraction (Per-Extension Layout)

Each installed extension owns a dedicated on-disk subtree at
`.swamp/pulled-extensions/<ext-name>/`, where `<ext-name>` is the extension's
scoped name (e.g. `@swamp/aws/ec2`). Inside that subtree, per-type directories
mirror the archive structure:

| Archive directory    | Destination                                                  |
| -------------------- | ------------------------------------------------------------ |
| `manifest.yaml`      | `.swamp/pulled-extensions/<ext-name>/manifest.yaml` (ro)     |
| `models/`            | `.swamp/pulled-extensions/<ext-name>/models/`                |
| `workflows/`         | `.swamp/pulled-extensions/<ext-name>/workflows/`             |
| `vaults/`            | `.swamp/pulled-extensions/<ext-name>/vaults/`                |
| `drivers/`           | `.swamp/pulled-extensions/<ext-name>/drivers/`               |
| `datastores/`        | `.swamp/pulled-extensions/<ext-name>/datastores/`            |
| `reports/`           | `.swamp/pulled-extensions/<ext-name>/reports/`               |
| `files/`             | `.swamp/pulled-extensions/<ext-name>/files/`                 |
| `bundles/`           | `.swamp/bundles/<bundleNamespace(per-extension models dir)>/`  |
| `vault-bundles/`     | `.swamp/vault-bundles/<bundleNamespace(…vaults dir)>/`       |
| `driver-bundles/`    | `.swamp/driver-bundles/<bundleNamespace(…drivers dir)>/`     |
| `datastore-bundles/` | `.swamp/datastore-bundles/<bundleNamespace(…datastores dir)>/` |
| `report-bundles/`    | `.swamp/report-bundles/<bundleNamespace(…reports dir)>/`     |
| `skills/`            | Tool-specific skills dir (e.g. `.claude/skills/<skill-name>/`) |

### Why extension-first?

Two sibling extensions from the same collective (e.g. `@swamp/aws/ec2` and
`@swamp/aws/eks`) frequently ship files with identical basenames — shared
helpers under `_lib/`, boilerplate like `README.md` and `LICENSE.txt`, and
occasional type-coincidences like `cluster.ts`. In a type-first (flat) layout,
these collide at extraction time: the second pull either errors with
`ConflictError` or silently overwrites the first with `--force`. The silent
overwrite is the dangerous case — `_lib/*` helpers are imported transitively
by model bundles, so a swap of `_lib/aws.ts` between ec2 and eks produces
incorrect runtime behavior with no type or load error.

Extension-first layout eliminates this entirely: each extension's files live
in a disjoint subtree keyed on its scoped name. The scoped name is already
a value object the registry uses for identity, so promoting it to the
filesystem aggregate root costs nothing beyond joining a path segment.

### manifest.yaml colocation

Each extension's archive manifest is extracted to
`.swamp/pulled-extensions/<ext-name>/manifest.yaml` with file mode `0o444`
(read-only) and prefixed with a `# Read-only; regenerate via 'swamp
extension pull'` header. Colocation makes every installed extension
self-describing on disk: `extension rm`'s dependent-resolution reads the
tracked manifest directly rather than re-fetching or re-parsing the
archive. The read-only mode is advisory on some filesystems (notably
Windows); it is documented via the header, not enforced as a security
boundary.

### Bundle cache isolation

`bundleNamespace(baseDir, repoDir)` hashes its input relative path. With
per-extension models dirs, each extension's hash is unique, so every
extension ends up in its own namespace under `.swamp/bundles/…` — bundle
keys are disjoint per extension without any additional logic. For
datastore-backed repos where `bundles/` is tiered to S3 (see
`DEFAULT_DATASTORE_SUBDIRS`), this means team members' bundle caches are
cleanly separated per extension.

If files already exist at the destination and `--force` is not set, the user is
prompted to confirm overwriting. Because every extension has its own subtree,
the only path that triggers ConflictError today is re-installing the same
extension on top of itself — cross-extension collisions cannot happen.

macOS resource fork files (`._*`) are skipped during both push (via
`COPYFILE_DISABLE=1`) and pull.

## Layout Migration

Existing repos that installed extensions under older layouts migrate via
`swamp repo upgrade`. Three generations are recognised:

- **gen-1 (pre-`.swamp/`):** files under `extensions/<type>/...`. `repo
  upgrade` renames them to `.swamp/pulled-extensions/<type>/...` and rewrites
  lockfile paths in place. Safe because the same bytes just move.
- **gen-2 (flat under `.swamp/`):** files under
  `.swamp/pulled-extensions/<type>/<file>`. Because filenames collide
  across extensions in this layout, prior installs may have silently
  overwritten each other, so rename cannot recover authentic content.
  `repo upgrade` instead selectively deletes each gen-2 entry's tracked
  files (leaving the lockfile unchanged); the next
  `swamp extension install` re-pulls each affected extension into its new
  per-extension subtree, with integrity verified against the lockfile's
  stored checksum.
- **current (per-extension):** files under
  `.swamp/pulled-extensions/<ext-name>/<type>/...`. No migration needed.

The lockfile tolerates mixed-generation state: each entry stands alone, and
the warn-not-block guard at the CLI layer proceeds with a one-line
reminder rather than hard-failing so that already-migrated extensions stay
usable during a partial upgrade. The migration is **resumable**:
`Deno.errors.NotFound` during selective delete is treated as success
(expected on a retry after an interrupted prior pass); any other IO error
aborts the upgrade before any further mutations, leaving the lockfile
intact so retry starts from a consistent state.

Skill directory entries (tracked as a single dir path in `entry.files[]`,
e.g. `.claude/skills/<name>`, `.cursor/skills/<name>`, or
`.swamp/pulled-extensions/skills/<name>` for the `tool=none` fallback)
are **always** treated as current-layout regardless of physical location.
The install flow filters them via the skillsDir wired through
`ExtensionInstallDeps` before classification runs, so they neither
trigger migration on their own nor get touched by the post-migration
sweep — without that filter, the `tool=none` fallback shape would be
indistinguishable from a gen-2 path and the freshly-restored skill dir
would be destructively removed. The path-only `classifyExtensionFile`
helper on its own only flags paths matching the documented gen-1 shape
(`extensions/<known-type>/...` where `<known-type>` is in
`PULLED_TYPE_DIRS`); arbitrary non-`.swamp/` paths and any path the
classifier doesn't recognise fall through to current-layout and are
ignored by migration rather than swept.

## Removal

Installed extensions can be removed with `extension rm`. Removal first
tombstones the extension's catalog rows (so its `(kind, type)` slots are
released atomically in one SQLite transaction), then removes the lockfile
entry, then deletes the on-disk files tracked in
`upstream_extensions.json` and prunes empty parent directories.

If other installed extensions list the target as a dependency (detected by
scanning their `manifest.yaml` files on disk), a warning is displayed before
proceeding.

A double-rm yields a clean `Extension <name> is not installed.` user
error on the second call — the lifecycle service decides "not installed"
when both the catalog AND the lockfile confirm absence, so partial-state
extensions still rm cleanly.

Extensions pulled before file tracking was added cannot be removed cleanly —
the user is prompted to re-pull with `--force` to populate the file list first.

## Lifecycle Services

`InstallExtensionService`, `RemoveExtensionService`, and
`UpgradeExtensionService` (in `src/libswamp/extensions/`) are the three
narrow seams through which the catalog gets written. The CLI command
files do not call the catalog directly — they construct the appropriate
service and call `execute(...)`. This is the W2 split that closed
[swamp-club#201](https://swamp-club.com/issues/201) (rm now prunes
catalog rows) and unblocks the W3+ unified-loader work.

### Asymmetric ordering

Install is **filesystem → lockfile → catalog**. Remove is the
**inverse**: **catalog → lockfile → filesystem**.

The asymmetry is not aesthetic. If rm went filesystem-first, the catalog
would briefly point at deleted bundle files and any concurrent type
resolution would crash for that window. Catalog-first means a mid-rm
crash leaves files on disk but the catalog clean — the next loader pass
surfaces the orphans via `findStaleFiles`. Symmetrically, install
catalog-last means a mid-install crash leaves on-disk files + lockfile
entry but no catalog rows; the next loader pass rebuilds the catalog
from the on-disk content via the existing cold-start path.

### Phase 8: synchronous type extraction at install

After the install service has written files to disk and the lockfile
entry, **phase 8** walks the per-extension subtree, calls each loader's
`bundleAndIndexOne(args)` for every source file, builds an `Extension`
aggregate whose Sources land in `Indexed` state with
`(kind, typeNormalized, bundlePath)` populated, and commits via
`repository.saveAll([extension])` in one SQLite transaction. The
repository's I-Repo-1 invariant — no two non-tombstoned Sources may
share `(kind, typeNormalized)` — fires synchronously at install time
rather than at the next steady-state loader pass. This is the
user-visible payoff of the W2 split: a cross-extension type collision
surfaces as a clean `DuplicateTypeUserError` *before* the user sees a
"successfully pulled" message.

`bundleAndIndexOne` is a strict per-loader contract: it bundles + type-
extracts + returns metadata, but **does not write to the catalog**. The
lifecycle service is the catalog-write owner — keeping it that way is
what lets I-Repo-1 fire on every install consistently.

### Atomic upgrade pattern

For every new aggregate the install service is about to save, it
tombstones any existing aggregate with the *same name* but a *different
version*, then submits everything to `saveAll` in one transaction:

```
saveAll([tombstoneAll(v1), ..., v2])
```

I-Repo-1 evaluates the **post-save** state, so the slot is held by
exactly one occupant: the new version. Without this pattern,
force-pulling an already-installed extension (or any version-bump pull)
would fail with `DuplicateTypeError` even though the only "conflict" is
the user's own prior version. Re-installs of the same version skip the
tombstone — the diff-save in `saveAll` handles overwrite semantics.

`UpgradeExtensionService` is a thin facade over
`InstallExtensionService.execute(...)` that lets call sites express
upgrade intent at the call site; the atomic-tombstone logic lives
inside the install service's phase 8.

### FS rollback on DuplicateTypeError

A genuine cross-extension `DuplicateTypeError` (two different extensions
trying to claim the same `(kind, typeNormalized)`) triggers an explicit
filesystem rollback before the error propagates: extracted files are
deleted and the lockfile entry is restored to its pre-install state.
SQLite ROLLBACK does not undo filesystem mutations, so the service does
this work explicitly. The error then propagates as a
`DuplicateTypeUserError` (a `UserError` subclass) so the top-level CLI
handler renders a clean single-line message in log mode and a structured
`duplicateType` object in `--json` mode:

```json
{
  "error": "Type \"@scope/foo\" (kind=model) is already claimed by ...",
  "duplicateType": {
    "kind": "model",
    "type": "@scope/foo",
    "existing":    { "extensionName": "...", "extensionVersion": "...", "canonicalPath": "..." },
    "conflicting": { "extensionName": "...", "extensionVersion": "...", "canonicalPath": "..." }
  }
}
```

The user-visible message points the user at
`swamp extension rm <existing-name>` to recover.

### Bounded atomicity

Each `execute(...)` is its own transaction. Bulk operations
(`extension update` over N extensions) run N independent transactions —
not one all-or-nothing batch. If extension A's upgrade rolls back due
to a collision with unchanged extension B, every other extension
already-upgraded in the bulk run **stays upgraded**. This is the
explicit bounded-atomicity contract: the unit of atomicity is the
single extension, never a multi-extension run.

### Crash-state recovery

A generic non-`DuplicateTypeError` failure inside `repository.saveAll`
(SQLite I/O error, OOM, process kill mid-commit) leaves the catalog in
its pre-save state via SQLite ROLLBACK. The filesystem and lockfile are
**not** auto-rolled-back — only `DuplicateTypeError` triggers FS
rollback. A retry succeeds: the diff-save in `saveAll` reconciles the
catalog against the on-disk + lockfile state.

For rm, the catalog tombstone is the **first** mutation, so a fault
inside that `saveAll` leaves all three layers (catalog, lockfile, FS)
in their pre-rm state — a retry is a clean re-rm.

The cross-process composition of these per-extension atomicity claims —
that `saveAll`'s SQLite WAL transaction, the lockfile advisory-lock retry,
and the asymmetric ordering above all hold under concurrent invocation
from independent OS processes against the same repository — is verified
by `integration/lifecycle_concurrent_stress_test.ts` (swamp-club#254). The
test runs 50 iterations of four concurrent `swamp` subprocesses each
(`extension pull` × 2 distinct extensions, `extension rm`, `extension
update`) and asserts catalog↔lockfile↔FS bijection, well-formed lockfile
JSON, no `DuplicateTypeError` leakage across distinct fixture types, and
no lockfile-retry-budget or SQLite-busy exhaustion at iteration end.

### W3+ inheritance

The lifecycle services' shape is W4-stable. The unified
`ExtensionLoader` (parameterized by `KindAdapter`) collapsed the five
per-loader `bundleAndIndexOne` methods to one dispatch, but the install/remove/
upgrade services keep their current public surface. CLI command files'
direct service construction (in `extension_pull.ts`,
`extension_update.ts`, `extension_rm.ts`, etc.) persists past W4.

### W3: ReconcileFromDisk + freshness as aggregate query

W3 introduces `ReconcileFromDiskService`
(`src/libswamp/extensions/reconcile_from_disk_service.ts`) and rewrites
the freshness contract as a two-layer model.

**Two-layer freshness model.** The freshness contract has two distinct
concerns:

1. **Type resolution layer** (W3 makes this trivial):
   `isFresh(state) = state === "Indexed"`. Constant-time aggregate
   query. All other RowState tags are not visible to type resolution.

2. **State maintenance layer** (split between two paths):
   - **Cold-start / explicit reconcile:** `ReconcileFromDiskService`.
     Full disk walk across all three origin types (locals, pulled,
     source-mounted). Post-hoc state repair. Fires when
     `anyKindNeedsInvalidation()` returns true (i.e. any kind's
     `isPopulated` flag is false).
   - **Warm-start / hot path:** `findStaleFiles` (preserved from
     pre-W3). Incremental fingerprint comparison. Fires per-loader
     `buildIndex` when the catalog is already populated.

The original W3 plan targeted slimming `findStaleFiles` to a ~20 LOC
deletion-sweep shim. Ground truth showed that warm-start incremental
detection is load-bearing for the development workflow — 12 loader
tests exercise this path. `findStaleFiles` retains its fingerprint
comparison. The scope change is deliberate.

**ReconcileFromDisk semantics.** The service:

- Walks on-disk source trees for all origin types.
- Loads current aggregate state via `repository.loadAll()`.
- Diffs disk vs aggregate and emits RowState transitions using the
  existing Extension aggregate methods.
- Delegates to per-loader `bundleAndIndexOne` for type extraction —
  NOT `InstallExtensionService`. The source is already on disk and the
  lockfile already exists; reconcile is post-hoc state repair.
- Saves via `repository.saveAll()` inside a single SQLite transaction.

**Locals vs pulled reconcile matrix:**

| Origin | Source on disk | Source in aggregate | Transition |
|--------|---------------|--------------------|-|
| Local | present | absent | `bundleAndIndexOne` → `Indexed` |
| Local | absent | present | `markSourceMissing` → `OrphanedBundleOnly` or `Tombstoned` |
| Pulled | present | absent | `bundleAndIndexOne` → `Indexed` |
| Pulled | absent | lockfile present | `recordEntryPointUnreadable` (re-fetch is W4) |
| Pulled | absent | lockfile absent | `Tombstoned` (orphan from failed rm) |
| Source-mounted | — | — | Follows local semantics |

**Trigger points:** cold-start (when `anyKindNeedsInvalidation()`
returns true) + explicit `swamp doctor extensions` call. NOT on every
command — reconcile would dominate the hot-path performance.

**dryRun mode:** `execute({ dryRun: true })` collects transitions
without calling `repository.saveAll()`. Returns structured
`ReconcileTransition` records (`{ source, fromState, toState, reason }`)
that W6's `swamp doctor extensions` will render directly.

**Transition-count guardrail:** if a reconcile run would transition
> 50% of existing rows (minimum 10 rows), the run aborts and returns
the transitions without applying them. Catches mass-tombstone bugs.

**enforceI2 transform.** W3 replaces the `IntraExtensionDuplicateType`
throw in the Extension aggregate's I2 enforcement with a
deterministic-winner + tombstone-loser transform. The Source with the
lexicographically smaller `canonicalPath` wins; the loser is tombstoned
with reason `"renamed"`. Cross-aggregate uniqueness (I-Repo-1) still
throws `DuplicateTypeError` at the repository layer.

**UNREADABLE_DEP_SENTINEL removal.** The sentinel constant was renamed
to `UNREADABLE_PLACEHOLDER` (internal to `computeSourceFingerprint`).
No external code compares against it. Broken transitive deps produce a
stable fingerprint; the failure surfaces at `bundleAndIndexOne` as
`BundleBuildFailed`. Existing catalog rows with the old sentinel value
are caught by the first reconcile run — no schema migration needed.

**Forward-only revert posture.** Same as W1b/W2: revert means deleting
`_extension_catalog.db` and rebuilding from disk on the next cold-start.

**Out of scope (deferred):**

- Bundle cache file eviction (W3 detects `OrphanedBundleOnly` but does
  NOT delete bundle files)
- Loader unification / `KindAdapter` (done in W4)
- `legacyStore` escape hatch removal (done in W4)
- `swamp doctor extensions` aggregate-state rendering → W6

## Lazy Per-Bundle Loading

Extension bundles are loaded lazily — individual bundles are imported on demand
rather than all at once. This keeps CLI response times constant regardless of
how many extensions are installed.

### Architecture

**Extension Catalog**: A SQLite database at `.swamp/_extension_catalog.db`
indexes all known bundle types. Each entry stores the type name, bundle path,
source path, source mtime, source fingerprint (sha-256 content hash), version,
and (for extensions) the base type it targets. Freshness is decided by the
content fingerprint; `source_mtime` is retained for observability only. The catalog lives at the `.swamp` root level because it is shared
across all registry types (models, vaults, drivers, datastores, reports). It
is completely independent of the data catalog (`_catalog.db`) used for data
queries.

The schema includes a `kind` column (`model`, `extension`, `vault`, `driver`,
`datastore`, `report`) so a single catalog supports all registry types. Only
the model registry is wired up initially.

**Loading Flow**:

1. On first `ensureLoaded()` call, the model registry's loader runs
   `buildIndex()` which:
   - Checks the catalog's `populated` flag
   - If populated: scans source directories, computes a sha-256 content
     fingerprint over each entry point plus its transitive local `.ts`
     dependencies, compares that against the catalog's stored fingerprint,
     rebundles only changed files, then registers lazy entries for all types
     from the catalog (no bundle imports). Fingerprint-based freshness
     replaced mtime-based freshness in issue #125 — mtime was fragile under
     atomic-rename saves, mtime-preserving sync tools, and sub-millisecond
     edits. The fingerprint is **total**: when a transitive dep is currently
     unreadable (broken symlink, deleted file, FilesystemLoop), its hash
     entry is replaced with a stable sentinel rather than throwing — so a
     stable broken state produces a stable fingerprint and the entry is not
     marked permanently stale (#208). Repairing the dep flips the sentinel
     back to a real hash and triggers a rebundle correctly. This property
     holds uniformly across all five extension kinds (models, drivers,
     vaults, datastores, reports) since they share the freshness service.
     Symmetrically, when an extension's source bundles and imports cleanly
     but fails schema validation (e.g. a required field was removed), the
     catalog row is upserted with the new fingerprint and a
     `validation_failed = true` marker (#209). Freshness comparison still
     works via fingerprint equality — the broken row is visible to
     `findStaleFiles` so a stable broken source produces a stable
     not-stale state. Registration paths filter on `validation_failed`,
     so the broken extension is correctly absent from the registry until
     the source is fixed. Editing the source to a different shape
     produces a new fingerprint, marks the file stale, triggers a
     rebundle, and flips the row back to `validation_failed = false`.
     This fix is scoped to the steady-state `rebundleAndUpdateCatalog`
     hot path — the cold-start parses (initial `loadModels` Pass 1, the
     by-name `loadSingleType`, and the extension-attach predicate)
     retain their existing failure semantics because they are not in
     the read-only steady-state loop.
   - **Fingerprint preservation on build failure (issue #265).** When
     `bundleWithCache` cannot regenerate a bundle (bare specifiers without
     a project `deno.json`, or a transient build error) and falls back to
     the cached `.js`, the `rebundleAndUpdateCatalog` caller preserves the
     catalog's _stored_ `source_fingerprint` instead of writing the new
     one. This keeps the file "stale" so `findStaleFiles` retries on the
     next warm-start invocation. Without this, the new fingerprint would
     be written alongside the old bundle content, permanently masking the
     staleness — `findStaleFiles` would see matching fingerprints and
     never retry. The warning log fires only on the fallback case
     (`fromCache && newFingerprint !== catalogFingerprint`), not on
     legitimate cache hits where the source hasn't changed.
     `findStaleFiles` uses fingerprint comparison, not RowState, for
     staleness decisions. `BundleBuildFailed` rows are skipped when
     fingerprints match (source unchanged) and retried when they mismatch
     (source changed) — warm-start and reconcile operate on orthogonal
     axes.

   - If not populated (first run or DB deleted): falls back to the existing
     full-import path, then populates the catalog from the loaded registry

2. `types()` returns both fully loaded and lazy type names — commands like
   `model type search` work without importing any bundles.

3. When a specific type is needed (e.g. `model get`, `model create`),
   `ensureTypeLoaded(type)` queries the catalog for the bundle path, imports
   just that bundle, and also imports any extension bundles targeting the base
   type.

4. Concurrent callers requesting the same type share a single load promise
   (per-type memoization).

### Self-Healing

The catalog self-heals: deleting `_extension_catalog.db` triggers a full import
on next access (same behavior as before lazy loading was added). The
`populated` flag follows the same pattern as the data catalog's backfill
mechanism.

### Roadmap

Per-bundle lazy loading for vault, driver, datastore, and report registries
will follow the same pattern using the shared `kind` column in the bundle
catalog schema.

## Reporting Issues Against Extensions

Users can file reports against a specific extension with `--extension <name>`
on the `swamp issue bug|feature|security` commands. The CLI routes the report
according to the extension's collective and its declared `repository`:

1. **`@swamp/*` extensions** — routed to the existing swamp-club Lab (the same
   endpoint `swamp issue bug` already uses). Extension name, installed version,
   and the reporter's environment are appended to the body under a
   `## Environment` section. The title is not modified.

2. **Third-party extensions with `repository` set** — routed to the declared
   upstream repository. When the `gh` CLI is installed and authenticated
   (`GH_TOKEN` or `gh auth login`), the report is created via `gh issue
   create`. Otherwise the CLI opens the provider's new-issue URL in the
   browser with title and body pre-filled (GitHub and GitLab supported;
   other hosts open the repo root and the prepared body is printed to the
   terminal for manual pasting).

3. **Third-party extensions without `repository`** — refused cleanly with
   guidance that points reporters at the extension's swamp-club page (where
   publisher contact info lives) and tells publishers to add a `repository:`
   field to their manifest. Exit code stays 0; the refusal is informational.

### Security Routing

For `swamp issue security --extension <name>` against a third-party GitHub
repository, the CLI first checks whether the repository has enabled GitHub's
Private Vulnerability Reporting (PVR) feature via `gh api
repos/<owner>/<repo>/private-vulnerability-reporting`:

- **PVR enabled** — open the GitHub advisory form
  (`<repo>/security/advisories/new`). The form is structured and doesn't
  accept URL prefill; the user fills it in manually.
- **PVR disabled** — **refuse**. This is a load-bearing security guardrail:
  the CLI never falls back to creating a public issue for a security report,
  because that would silently publish the vulnerability. The refusal guidance
  tells the reporter to contact the publisher privately and tells the
  publisher to enable PVR at `<repo>/settings/security_analysis`.
- **PVR check failed or gh unavailable** — open the advisory URL with a
  fallback issue URL surfaced in the output. The user decides after seeing
  what GitHub responds with.

The asymmetry between GitHub (hard refusal when PVR is off) and GitLab
(routes to the normal issue form with a "toggle confidential" warning) is
intentional: GitLab's confidential-issues feature is universal and
reliable, so the user always has a safe in-form path. GitHub's PVR is
opt-in per repo, so the CLI refuses rather than trust the reporter to
remember not to file publicly.

### Publish-Time Nudge

When `swamp extension push` runs against a manifest without a `repository`
field, the CLI emits a non-blocking warning reminding the publisher that
users will not be able to file issues via `--extension`. The warning never
blocks the push — some publishers may deliberately omit `repository`.
