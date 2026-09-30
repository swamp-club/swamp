---
audience: extension-author, maintainer
last-verified: 2026-09-16 @ 03224b68
---

# Extensions

An extension is a package of models, workflows, vaults, datastores, reports and
skills that others can pull from a registry into their repositories.

Four kinds have a runtime type registry and loader: models, vaults, datastores
and reports (`src/cli/mod.ts` wires only these four).

## Name

Every extension has a scoped name, `@collective/name`. Extra path segments may
group related extensions. All parts are lowercase letters, digits, hyphens and
underscores. The pattern is `@[a-z0-9_-]+/[a-z0-9_-]+(/[a-z0-9_-]+)*`.

The collectives `@swamp` and `@si` are reserved for built-in extensions, so
external authors cannot use them. This is enforced on model types, not when the
manifest is parsed (`RESERVED_COLLECTIVES` in
`src/domain/models/model_type.ts`).

You cannot use another person's name in the extensions you publish.

Examples: `@keeb/ssh`, `@acme/deploy`, `@myorg/aws-helpers`, `@swamp/aws/ec2`,
`@swamp/aws/accessanalyzer/analyzer`.

## Version

Extensions use **CalVer** `YYYY.MM.DD.MICRO` (e.g., `2026.02.26.1`), the same
scheme as models (see [models](./models.md)). The micro counter allows several
versions a day and resets each new date.

Each name+version pair must be unique in the registry. On a push conflict, the
CLI offers to bump the version.

### Epoch suffix

`swamp extension push manifest.yaml --version-suffix epoch` replaces the micro
segment with the current Unix epoch seconds, e.g. `2026.06.18.1750263600`. This
avoids push collisions in CI, where nobody can answer a bump prompt. Each push
gets a unique, increasing version that records the exact publish time, and the
date prefix stays readable.

`swamp extension version <name>` asks the registry for the latest published
version and computes the next one. It takes an extension name, or
`--manifest <path>` to read the name from a manifest. It works outside a swamp
repository.

## Publication Visibility

A manifest may set `visibility: public` or `visibility: private`.
`swamp extension push manifest.yaml --visibility private` sets the same intent
for one publication and wins over the manifest. With neither, registry defaults
apply. `public` selects that default, so `--visibility public` overrides a
private manifest. It does not make an already-private extension public or
override a private collective's default. Release channels are independent of
visibility.

The effective intent is stored in the packaged manifest and the package cache
key. Private intent is sent on both initiation and confirmation. Public or
default intent omits the wire field, since the registry accepts only explicit
private. Preview and dry-run show the requested `visibility` as `public`,
`private` or `default` (registry decides); public is labelled as registry-default
behavior. Dry-run does not establish entitlement or the applied visibility.
Successful output reports the actual `public`/`private` visibility from the
confirmation response. Explicit private requests require a private confirmation
and never fall back to a best-effort lookup.

The upgraded registry creates explicit-private extensions as private from the
start, even inside public collectives, and enforces namespace permissions and
private-extension entitlements. Republish with private intent to keep that
requirement. An already-public extension produces a conflict; use the registry's
visibility action first. With public or omitted intent, new extensions take
their collective's default and existing ones keep their own visibility.

Explicit private publication needs the private-publication API from Lab #2200 on
**all registry replicas**. Older servers ignore the field, and checking the
confirmation cannot undo public exposure. Finish the registry rollout first,
including on custom registries, and pause explicit-private publishing while
rolling back to an older service. Public or omitted requests still work with
older servers, including their old visibility-lookup fallback.

## Release Channels

Extensions have three release channels with a strict promotion order:

```
beta → rc → stable
  └──────────┘  (can skip rc)
```

- **stable**: the default. All existing versions are stable. Omitting
  `--channel`, or passing `--channel stable`, on push and pull means stable.
  Auto-resolve considers only stable versions.
- **rc**: release candidate. Opt in with `--channel rc`.
- **beta**: early preview. Opt in with `--channel beta`.

### Version uniqueness

A version is unique per extension across all channels; you cannot push
`2026.06.10.1` as both beta and stable. So promotion changes only metadata, and
the archive bytes and checksum stay the same.

### Push

`swamp extension push manifest.yaml --channel rc` pushes to rc and
`swamp extension push manifest.yaml --channel beta` to beta. With no
`--channel` flag, push goes to stable.

### Pull

`swamp extension pull @name` resolves the latest stable version. For a
prerelease-only extension it fails with a message suggesting the right
`--channel` flag. `swamp extension pull @name --channel rc` and
`swamp extension pull @name --channel beta` resolve the latest rc or beta.
Pinning an exact version (`@name@2026.06.10.1`) ignores the channel.

### Search and Versions

`swamp extension search --channel rc --channel beta` shows extensions with
versions in either channel. `--channel` can be repeated; without it, only stable
results are shown.

`swamp extension version @name` shows the latest published version and computes
the next CalVer version.

### Info

`swamp extension info @name` always shows the latest stable, rc and beta
versions that exist. No flag is needed.

It also shows content metadata for the latest version: model types, extensions
(foreign-type grafts), workflows, vaults, datastores, reports and skills. By
default models show the type name and method names, and extensions show the
target type and grafted method names. `--verbose` adds each method's arguments
and descriptions. JSON output (`--json`) includes the full `contentMetadata`
object.

### Promotion

`swamp extension promote @name 2026.06.10.1 --channel rc` promotes a beta
version to rc; `--channel stable` promotes to stable. Only forward moves are
allowed:

- beta → rc ✅
- beta → stable ✅
- rc → stable ✅
- stable → rc ❌
- rc → beta ❌
- stable → beta ❌

Promotion changes registry metadata only; the archive is not uploaded again.
The server then recalculates the latest version per channel. The CLI checks the
direction only when `--from-channel` is given; otherwise the server enforces it
(`src/libswamp/extensions/promote.ts`).

### Auto-resolve safety

Trusted-collective auto-resolution uses only stable versions, never beta or rc.
Lockfile-pinned restores fetch the exact version whatever its channel.

Concurrent processes that auto-resolve in one repository install one at a time:
each takes a repo-wide lock (`.swamp/.extension-install.lock`) around
inspecting, installing and loading. A process that then finds the extension
already installed by another loads it rather than failing, and reports the
type missing only when the loaded extension does not provide it
(`src/domain/extensions/extension_auto_resolver.ts`). The install itself also
takes the per-checkout pulled-extensions lock (see
[Concurrency Safety](#concurrency-safety)), which serializes it against
explicit installs and removals.

### Lockfile

The `upstream_extensions.json` entry records the install channel in a `channel`
field. It is written only for non-stable installs, so entries without it read
as `"stable"` (`src/infrastructure/persistence/lockfile_repository.ts`). The
update service looks for updates within the installed channel.

### Update cache

The update check cache (`.swamp/extension-update-checks.json`) keys stable
entries by the bare extension name, for backward compatibility, and non-stable
ones by `name:channel` (e.g. `@swamp/aws:rc`).

## Freshness

Two opt-in commands report whether installed extensions are behind the
registry. There is no passive warning on load.

### `swamp extension list`

When stdout is a terminal, this adds a "latest" column to the installed
extensions table. Outdated rows are marked `(update available)`, and rows where
the registry was unreachable `(offline — last check failed)`. Two flags control
this:

- `--check-updates` forces enrichment on, e.g. in CI to get the side-by-side
  view in JSON output.
- `--no-check-updates` forces it off.

By default, enrichment runs only when stdout is a terminal and the output mode
is `log`. JSON output and piped runs skip it, so scripted `extension list` stays
cheap and offline.

When enrichment ran, each JSON entry has optional `latestVersion` and
`updateStatus` fields. `updateStatus` is one of `up_to_date`,
`update_available`, `unknown_offline` or `deprecated`
(`src/presentation/renderers/extension_list.ts`). Consumers can tell "didn't
try" (fields absent) from "tried and failed" (`updateStatus: "unknown_offline"`,
`latestVersion: null`).

Two more optional fields appear whether or not enrichment ran
(`src/libswamp/extensions/list.ts`, swamp-club#2483):

- `onDiskVersion` is present when the version in the extension's on-disk
  manifest differs from the version the lockfile pins, so the loaded code is not
  what the lockfile pins. Log mode shows `(on disk vX)` on the row, then a
  remedy line.
- `autoResolved: true` marks an entry that comes only from the transitional
  in-repo auto-resolve lockfile, not the team's. Log mode shows
  `(auto-resolved)` on the row. `update`, `rm` and `install` act on the team's
  lockfile only, so they do not see such an entry. It is never checked for
  updates (no `latestVersion` or `updateStatus`), and log mode ends with a
  footer saying `update` and `rm` do not manage it. Until swamp-club#2495, it is
  repaired by deleting what it installed so the auto-resolver reinstalls it;
  `extension pull` would pin it in the team's lockfile. Once its directory and
  source files are all gone it is not listed, since it awaits that reinstall.
- `removeToReinstall` accompanies `autoResolved`: the repo-relative paths to
  delete for that reinstall, namely the extension's directory and any pulled
  skill dirs it tracks. A skill dir another extension also claims is shared,
  so only this extension's own files in it are listed. A surviving skill would
  make the auto-resolver report the extension as a legacy install instead of
  reinstalling it. The log-mode
  remedy line names these paths.

### `swamp extension outdated`

A subcommand for CI gates and scheduled checks. It shows every status other than
up_to_date (update_available, not_found, failed), but the exit code depends only
on update_available:

- Exit 1 if at least one extension has status `update_available`.
- Exit 0 otherwise, including when only `not_found` or `failed` are present.

So `swamp extension outdated && deploy` fails only when a newer version clearly
exists, not on transient registry errors. This exit code is a public contract.
Widening it to fail on not_found/failed would silently break pipelines that rely
on it.

### Deprecation

An extension can be deprecated without being yanked. Deprecated extensions can
still be pulled and resolved, so existing workflows keep working.

`swamp extension deprecate` deprecates a whole extension, not single versions.
The optional `--superseded-by` flag names a replacement.
`swamp extension undeprecate` reverses it.

Deprecation shows up in five places:

- `swamp extension search` shows `[deprecated]` next to the extension.
- `swamp extension info` shows the deprecation time, reason and successor (if
  set).
- `swamp extension pull` warns and names the successor.
- `swamp extension outdated` reports a `deprecated` status alongside
  `update_available`, `not_found` and `failed`. Like not_found/failed, it does
  not fail the exit code, because the extension still works.
- `swamp extension list --check-updates` marks the extension `(deprecated)`
  when the enrichment status is available.

Registry API endpoints are `POST /api/v1/extensions/{name}/deprecate` (body:
`{reason, supersededBy?}`) and `POST /api/v1/extensions/{name}/undeprecate` (no
body). The extension info view returns `deprecatedAt`, `deprecatedByUserId`,
`deprecationReason` and `supersededBy`.

### Cache and registry behavior

Both commands share a 24-hour on-disk cache at
`.swamp/extension-update-checks.json`. The TTL matches `CHECK_INTERVAL_MS` in
`src/domain/update/update_check_cache.ts`. Within that window, freshness comes
from the cache without contacting the registry. The commands only read the
registry; nothing is pulled or upgraded as a side effect.

If the registry call fails for a stale entry, the cache stores
`latestVersion: installedVersion` so it does not retry for 24h. During that time
the entry reads as `up_to_date` although the latest version is unknown. For
advisory data, that is better than every command hitting an unreachable
registry. The in-memory entry from the list composer also carries
`updateStatus: "unknown_offline"`, so within one run the user can tell "just
failed" from "cached up_to_date". After 24h the entry expires and the next
command tries again.

The cache file is written with `atomicWriteTextFile`, so concurrent writers
cannot corrupt it. The repository rewrites the whole map, though, so parallel
runs can lose each other's changes (last writer wins). Entries are independent
and advisory, so a lost change recurs on the next stale check. A
per-extension file or kvstore would remove this trade-off and is a future
improvement.

### Why no passive on-load warning

The original request (issue #199) asked for a warning on every command that
resolves an extension bundle. Comparable tools pointed the other way:

- Terraform, OpenTofu and Ansible all chose not to nag passively about
  plugin/provider staleness, leaving it to the user to opt in. OpenTofu
  reconsidered (issue #2032, closed not-planned) over CI breakage concerns.
- Pulumi warns passively about the CLI itself, not plugins, and users have
  complained about noise on every run (issue #5576), the wrong severity (issue
  #10578), and warnings they can't act on when package managers lag (issue
  #2426).
- No surveyed tool has a well-liked per-extension passive warning. gh's
  extension version checker came closest, and it caused problems (issue
  #10235: a blocking PostRun call hangs commands for minutes).

If demand appears, the documented but unbuilt design is one aggregated line at
the end of a command: info level (not warn), 24h display cooldown, TTY gating,
env-var suppression, and non-blocking, time-limited registry calls.
(`SWAMP_NO_UPDATE_CHECK` in `src/cli/mod.ts` turns off the CLI's own
self-update check, not extension freshness.) Per-extension warnings at the
start of every command are ruled out.

## Manifest

Every extension is defined by a `manifest.yaml` file that declares its contents
and how to package them.

### Required Fields

- `manifestVersion`: must be `1`, the only supported version.
- `name`: scoped name (`@collective/name`).
- `version`: CalVer version string.
- At least one of `models`, `workflows`, `vaults`, `datastores`, `reports`,
  `webhooks` or `skills`.

### Path Safety

Every manifest path must be **relative and downward-only**. Push rejects paths
with `..` components (e.g., `../../workflows/file.yaml`) or a leading `/`
(absolute paths). Such paths would produce archive entries that pull's safety
check rejects, since it refuses any tar entry containing `..` or starting with
`/`.

### Optional Fields

- `description`: human-readable description.
- `paths.base`: how the typed keys below resolve, `"typedDir"` (default) or
  `"manifest"`. See "Path resolution" below. Under `"manifest"`, entries must not
  repeat the typed directory prefix, because the archive already puts each entry
  under its typed directory: write `models: ["project.ts"]`, not
  `models: ["models/project.ts"]`.
- `models`: relative paths to TypeScript model files (e.g.,
  `["aws/ec2/instance.ts"]`). Resolved via `paths.base`.
- `workflows`: relative paths to YAML workflow files. Resolved via `paths.base`.
- `vaults`, `datastores`, `reports`: relative paths to TypeScript vault,
  datastore and report files. Resolved via `paths.base`.
- `skills`: skill directory names. Each must contain a `SKILL.md` whose YAML
  frontmatter declares `name` and `description`. Skills are passive markdown
  guidance; swamp never runs them.
- `repository`: URL of the source repository (e.g.,
  `"https://github.com/org/repo"`).
- `releaseNotes`: free-form notes for this version (max 5000 characters).
- `include`: relative paths to files copied into the archive next to models but
  not bundled, such as helper scripts run as a `Deno.Command` subprocess rather
  than imported. Resolved via `paths.base`.
- `additionalFiles`: relative paths to non-model files (README, config, etc.).
  Always resolved relative to the manifest's own directory.
- `platforms`: supported platform identifiers (e.g.,
  `["darwin-aarch64", "linux-x86_64"]`). Informational only; shown during pull.
- `labels`: categorization labels (e.g., `["aws", "kubernetes"]`), at most
  `MAX_LABELS = 20` (`src/domain/extensions/extension_manifest.ts`).
- `dependencies`: extension names (`@collective/name`) this extension needs.
  They are pulled automatically.

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
labels:
  - ssh
  - networking
```

### Path Resolution

`paths.base` picks the directory that typed-key entries (`models`, `vaults`,
`datastores`, `reports`, `include`) and `additionalFiles` resolve against during
push:

- **`typedDir` (default)**: typed entries resolve relative to their configured
  directory from the repo marker (`modelsDir`, `vaultsDir`, etc., or environment
  overrides like `SWAMP_MODELS_DIR`). `additionalFiles` resolves relative to the
  manifest's own directory. This is the original behavior, kept by every
  manifest without `paths.base`.
- **`manifest`**: every typed entry and `additionalFiles` resolve relative to
  the manifest's own directory. Use it when each extension has its own
  subdirectory holding manifest, source, README and LICENSE (e.g.
  `extensions/models/myext/manifest.yaml` next to `myext/echo.ts` and
  `myext/README.md`).

Workflows honour `paths.base: manifest`: the manifest's own directory is
searched first, then the repo-root `workflows/` and `extensions/workflows/`
directories. Under the default `paths.base: typedDir`, only the repo-root
locations are used.

Skills honour it too: the manifest's own directory first (e.g.
`sub/.claude/skills/<name>/`), then the repo-root (project-local) skill
directory, then the global user-level one. Under `paths.base: typedDir`, only
repo-root and global are searched. Every enrolled tool's skill directory is
searched, not only the primary tool's.

Local source loading also honours `paths.base: manifest`. At startup the loader
scans every known extension directory for such manifests. If one declares a kind
other than its parent directory's (e.g. a `reports:` entry in a manifest under
`extensions/models/myext/`), its directory becomes an extra source directory for
that kind. This closes a gap between dev and prod. Published bundles loaded
every declared component, but local loading only found components in the
matching kind directory.

### Source-Path Skill Installation

Source-path extensions (set up in `.swamp-sources.yaml`) can provide skills too.
When `extension source add` records a source, it reads its `manifest.yaml`. If
that declares `skills`, it copies those skill directories into the repo's
tool-specific skills directory (e.g. `.claude/skills/`). Resolution uses the
same `paths.base` strategy as `extension push` and `extension quality`: relative
to the manifest under `paths.base: manifest`, otherwise under the source root's
tool-specific skill directories.

The installed skill names are recorded in the `installedSkills` field of the
source entry in `.swamp-sources.yaml`. `extension source rm` reads this field
and deletes those skill directories, so cleanup works even if the source
directory is gone.

The manifest in the archive keeps its field strings as written, with no
path rewriting or normalization, so the registry stores what the author pushed.
The archive layout under each typed-key directory follows the entry strings:
under `paths.base: manifest` with `models: [echo.ts]`, the archive contains
`extension/models/echo.ts` directly.

## Archive Structure

On push, an extension is packaged as a gzipped tar archive:

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
    ├── datastores/           # Source TypeScript datastore files
    ├── datastore-bundles/    # Compiled datastore JavaScript bundles
    ├── reports/              # Source TypeScript report files
    ├── report-bundles/       # Compiled report JavaScript bundles
    ├── skills/               # Skill directories (SKILL.md + references)
    └── files/                # Additional files
```

### Models

Source TypeScript files keep their paths relative to the active base: the
configured `modelsDir` under `paths.base: typedDir`, or the manifest's directory
under `paths.base: manifest`. Local imports are followed recursively; if
`connection.ts` imports `./helpers.ts`, both are included.

Files in `include` are also copied to `models/`, keeping their paths relative to
the active base. They are not bundled; they are raw TypeScript meant to run as
subprocesses or standalone utilities.

### Loader pre-check

At runtime, loaders find `.ts` files in their directories and try to bundle
each. First the loader reads the source and looks for the expected named export
(`export const model`, `export const vault`, etc.). Files without it are skipped
silently, with no bundling attempt and no error. This way helper scripts with
unbundleable dependencies (e.g., native modules used via a `Deno.Command`
subprocess) cause no failures.

### Bundles

Each model entry point is compiled with `deno bundle`, with zod externalized.
All other non-local specifiers (`npm:`, `jsr:`, `https:`) are resolved and
inlined, so they work in the compiled binary, where only swamp's own embedded
dependency graph exists. Zod stays external so extensions share swamp's zod
instance, which schema `instanceof` checks require. Dynamic `import()` is not
supported; all imports must be static and top-level. Bundles are JavaScript
files stored next to their sources under `bundles/`.

**Specifier kinds:** `deno bundle` handles `npm:`, `jsr:` and
`https:` natively and alike. All are inlined, cached by Deno's module cache, and
follow the same zod externalization rules, with no per-kind configuration.

**Pin versions on all non-local specifiers** (`npm:`, `jsr:`, `https:`) for
reproducibility. An unpinned specifier resolves to the registry's "latest" at
push time, so the published bundle changes silently whenever upstream releases.
Author guidance is in
`.claude/skills/swamp/references/extension-publish/references/publishing.md`.

#### Project-aware bundling

An extension may live inside a project with a `deno.json` or `package.json`.
`swamp extension push` walks up from the manifest directory to the repo root
looking for project config.

**Detection priority:** push walks the whole path for `deno.json` first. Only if
it finds none does it walk again for `package.json`. So `deno.json` always wins,
whatever its depth.

**Bare specifier gate:** a `package.json` is used only if the extension source
has bare specifiers (e.g., `from "zod"` rather than `from "npm:zod@4"`). This
keeps an unrelated `package.json` (e.g., one listing `@anthropic-ai/claude-code`
for tooling) from being taken as the extension's project config.

Specifiers come only from the module's own static imports. Import statements
inside template literals are generated code for a script the extension emits at
runtime, not part of its own module graph, so every bare-specifier check ignores
them.

#### Bundling permutations

| Scenario                                  | `deno bundle` flags                                      | Quality check flags    | Notes                                                                                                            |
| ----------------------------------------- | -------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **`deno.json` found**                     | `--config <deno.json>`                                   | `--config <deno.json>` | Import map governs resolution; project lint/fmt rules apply                                                      |
| **`package.json` found, bare specifiers** | `--node-modules-dir=auto`, `cwd` set to package.json dir | `--no-config`          | Deno auto-detects package.json; `node_modules/` must exist from `npm install` or `deno install`                  |
| **`package.json` found, `npm:` imports**  | `--no-lock --node-modules-dir=none`                      | `--no-config`          | Package.json is ignored (extension doesn't need it)                                                              |
| **No config found**                       | `--no-lock --node-modules-dir=none`                      | `--no-config`          | Default behavior                                                                                                 |

In the bare-specifier row, `--node-modules-dir=auto` also creates `.deno/`
metadata if needed.

`--node-modules-dir=none` is required in the last two rows. Without it, any
`package.json` in the directory tree switches Deno to `node_modules/`
resolution, which breaks `npm:` imports with errors like "Could not find a
matching package for 'npm:@octokit/rest@22.0.1' in the node_modules directory."

`jsr:` and `https:` specifiers behave the same in all four rows. They need no
`deno.json` or `package.json`, so project-config detection does not affect them.
Deno's module cache fetches them on first use and reuses them offline.

#### Zod externalization

Zod is externalized with `--external` flags matching the specifier as written.
The bundler handles:

- `npm:zod@4` and `npm:zod` (base patterns, always applied)
- Fully pinned versions like `npm:zod@4.3.6` (found by scanning the source)
- Bare `"zod"` via `deno.json`: when the import map maps it to zod 4.x, both the
  resolved specifier and bare `"zod"` are externalized
- Bare `"zod"` via `package.json`: when `dependencies` or `devDependencies`
  lists zod 4.x

After bundling, `rewriteZodImports` rewrites each externalized zod import to
`globalThis.__swamp_zod`, which `installZodGlobal()` sets at runtime. The
rewrite matches `npm:zod@4.x` and bare `"zod"` but excludes zod 3.x, to avoid
silent runtime breakage.

#### Runtime bundle caching

At runtime, loaders look for cached bundles in `.swamp/bundles/` (or the
matching `-bundles/` directory). If the source has bare specifiers that need a
project config and a cached bundle exists, the loader uses it, since
re-bundling without the config would fail. This serves pulled extensions built
in a `deno.json` or `package.json` project, whose archive has pre-built bundles
but no project config. Imports inside template literals don't count here either,
so an extension that only generates code re-bundles normally.

With a non-filesystem datastore (e.g. `@swamp/s3-datastore`), bundle paths go
through the `DatastorePathResolver` instead of the hardcoded local `.swamp/`
directory, so bundle reads and writes use the datastore cache path (e.g.
`~/.swamp/repos/<repo-id>/bundles/`). The datastore loader is the exception.
Because of bootstrap order it always uses the local path: it loads the
datastore extensions that configure the resolver. Without a resolver (e.g.
during `repo init` or in tests), loaders fall back to the local `.swamp/` path.

### Vaults, Datastores, Reports, and Webhooks

Vault, datastore, report and webhook entry points are bundled like models. Each
gets a compiled `.js` file in its `-bundles/` directory (`vault-bundles/`,
`datastore-bundles/`, `report-bundles/`, `webhook-bundles/`). Local imports are
followed recursively within the directory. The install-time `KIND_DIRS` array
covers `["models", "vaults", "datastores", "reports", "webhooks"]`.

Each bundle's export is validated against a Zod schema:

- **Vaults**: `export const vault` with `type`, `name`, `description`,
  optional `configSchema`, and `createProvider`
- **Datastores**: `export const datastore` with `type`, `name`,
  `description`, optional `configSchema`, and `createProvider`
- **Reports**: `export const report` with `name`, `description`, `scope`,
  optional `labels`, and `execute`
- **Webhooks**: `export const webhook` with `type`, `name`, `description`,
  optional `configSchema`, and `createHandler`. `createHandler` returns the
  handler for `swamp serve` webhook endpoints whose scheme is the type (see
  [serve](serve.md))

### Collective Validation

Push checks that all content (model types, vault types, workflow names,
datastore types, report names, webhook types) uses the extension name's
collective, so an extension cannot register types under another collective.

### Workflows

Workflow YAML files get unique archive names derived from their directory path,
so they don't collide.

### Additional Files

`additionalFiles` go under `files/`, keeping their relative paths. A manifest
entry `prompts/review.md` lands at `files/prompts/review.md` in the archive, and
at `.swamp/pulled-extensions/<name>/files/prompts/review.md` for consumers.

Push rejects:

- Duplicate entries (case-insensitive, NFC-normalized). Two entries mapping to
  the same archive path fail with an error naming both.
- Symlinks, to avoid archive bloat and path escapes. Copy the target file into
  the extension tree instead.

### Runtime access

Model method `execute` functions and report functions get a context with an
`extensionFile(relPath)` helper. It turns a relative `additionalFiles` path into
an absolute path, whether the extension was added with
`swamp extension source add` (relative to the manifest) or pulled from the
registry (under `.swamp/pulled-extensions/<name>/files/`).

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

The helper throws a typed `UserError` if the path is unsafe (contains `..` or
starts with `/`), the file is missing, or the model was not shipped via an
extension manifest. For a missing file, pulled archives get a re-publish hint;
source-mode callers get the absolute path and a pointer to the manifest entry.

## Import Resolution

When packaging, the CLI follows local TypeScript imports from each entry point
(model, vault, datastore or report). It follows relative `import`/`export`
statements (e.g., `./helpers.ts`, `../shared.ts`) transitively and includes
every file reached inside that kind's directory boundary. Non-local imports
(`npm:`, `jsr:`, `https:`) are skipped here; `deno bundle` inlines them at
bundle time.

## Per-Subdirectory Extension Identity

By default, all files under `extensions/<kind>/` form one local extension
aggregate, `@local/<repo-basename>@0.0.0`, or the identity in the top-level
`extensions/manifest.yaml` if present.

If a subdirectory directly under `extensions/<kind>/` has its own
`manifest.yaml` declaring both `name` and `version`, it becomes a separate
aggregate. Its files belong to that identity instead of the default
`@local/<repo>` aggregate. Sibling directories can then hold separately
published extensions:

```
extensions/models/
  foo/
    manifest.yaml    # name: @ns/foo, version: 2026.06.01.1
    instance.ts      → claimed by @ns/foo@2026.06.01.1
  bar/
    manifest.yaml    # name: @ns/bar, version: 2026.06.01.1
    instance.ts      → claimed by @ns/bar@2026.06.01.1
  shared.ts          → claimed by @local/<repo>@0.0.0
```

**Precedence:** a top-level `extensions/manifest.yaml` claims the whole
`extensions/` tree and per-subdirectory manifests are ignored. Per-subdirectory
discovery applies only without one.

### Origin Precedence Enforcement

If a local source and a pulled extension provide the same `(kind, type)`, the
local source wins. The catalog clears the pulled row's `type_normalized`, so the
row no longer occupies the type namespace. This is the same treatment the
catalog gives `ValidationFailed` or `EntryPointUnreadable` states. The pulled
files stay on disk for reference (diffing, version comparison) but are not
registered as active types.

This supports the push/pull development loop: while you edit a local source that
is also pulled from the registry, `extension pull` succeeds and the local types
take precedence. The in-memory registry always worked this way (`load()`
processes local directories first and deduplicates with `hasType()`); the
catalog now matches. That dedupe covers primary types only. Members that
`export const extension` files add to a type follow the rules below.

When the local source is removed, the next loader pass re-activates the pulled
type on its own (see [Stale-source healing](#stale-source-healing)). If two
pulled extensions provide the same `(kind, type)`, the one that already holds
the type keeps it, so pulling another extension never takes a type away. The
loader warns that it chose between them, naming both extensions and the
`swamp extension rm` that switches to the other.

### Extension Member Collisions

Several `export const extension` files can add a member (a method, check or
resource spec) with the same name to one model type. Only one of them is
registered, and the winner does not depend on catalog order or on which attach
path ran (swamp-club#2562):

1. A member the base model defines always wins.
2. Between extensions, a non-pulled source (local or source-mounted) beats a
   pulled one. A source is pulled when its path is under
   `<repo>/.swamp/pulled-extensions/` or `<repo>/.swamp/config/pulled-extensions/`
   (`isPulledExtensionPath`, which `resolveOriginConflicts` shares).
3. Within one tier, the lexicographically smaller canonical path wins, the same
   tie-break as I2.

The model kind adapter records which extension contributed each member, along
with the definition it contributed. When a higher-ranked extension attaches
later, whether through a stale rescan, an auto-install, or serve reload,
`ModelRegistry.applyExtensionMembers` replaces the lower-ranked member in one
immutable merge. `extend()` itself still refuses to replace anything. A source
that re-attaches replaces its own members silently. Because the record also
stores the definition object, a member whose current definition is not the
recorded one counts as a base member, which wins. Each collision emits one
`MemberCollision` warning that names both files and the winner, and
`getExtensionMemberCollisions()` exposes the resolved state for
`swamp doctor extensions`. The loser's other members stay registered, so an
extension can end up partly active.

Every attach path (`load()`, `loadSingleType`, and
`attachPendingExtensionsForType`) marks a processed extension attached by
source path and fingerprint, so a later pass does not import it again.

Cold-start indexing defers to rows written by the import-based reconcile. When
`populateCatalogFromDir` finds an indexed row with the same fingerprint, it
keeps that row instead of re-reading the type from source text. That keeps
exports the static extractor cannot read, such as
`export const extension = withOptions(definition)`, from warning on every
catalog rebuild.

The lookup also finds a row written under another spelling of the same file.
Reaching the repo under a second spelling of its root (`/tmp/r` and
`/private/tmp/r` on macOS) changes the source-dirs fingerprint and forces a
cold rebuild. When the exact lookup misses, the loader matches rows outside its
own spelling of the repo root by symlink-resolved path, in either direction. An
up-to-date match is moved to the current spelling, leaving one row per file, as
the next warm scan would.

## Split Extensions Directory (`--extensions-dir`)

By default, swamp finds local extension sources in `extensions/<kind>/` under
the repository root (`--repo-dir` / `SWAMP_REPO_DIR`). The `--extensions-dir`
flag (or `SWAMP_EXTENSIONS_DIR` env var) moves only the source scanning root;
all data stays at the repository root.

This supports **git worktree** setups where the working tree (code plane) is
separate from the `.swamp/` data directory (data plane):

```
# Main repo has .swamp/ data + original extensions
~/repo/
  .swamp/          ← data, bundles, catalog (data plane)
  .swamp.yaml      ← repo marker
  extensions/models/my-model.ts

# Worktree has its own working copy of extensions
~/repo/trees/feature-branch/
  .swamp.yaml      ← same marker (committed to git)
  extensions/models/my-model.ts      ← modified copy
  extensions/models/new-model.ts     ← worktree-only
```

Usage:

```
SWAMP_REPO_DIR=~/repo \
SWAMP_EXTENSIONS_DIR=~/repo/trees/feature-branch \
  swamp model type search my-model
```

### What `--extensions-dir` controls

- Local extension source scanning for all 4 kinds (models, vaults, datastores,
  reports)
- Manifest path resolution in `extension fmt` and `extension push`

### What stays at `--repo-dir`

- `.swamp/` data directory (outputs, data artifacts, workflow runs)
- Extension catalog (`_extension_catalog.db`)
- Bundle cache (`.swamp/bundles/`)
- Pulled extensions (`.swamp/pulled-extensions/`)
- Model definitions (`models/<type>/<id>.yaml`)
- Lockfiles and secrets

### Validation

The CLI rejects an `--extensions-dir` inside `.swamp/`, so data-plane files are
never read as extension sources. The path must be an existing directory.

## Adversarial Review Directory (`SWAMP_EXTENSION_REVIEW_DIR`)

The adversarial review gate in `swamp extension push` looks for a report tied to
the content hash at `<base>/swamp-extension-review/<name>-<hash>.json`. By
default `<base>` is the OS temp directory (`TMPDIR` / `TMP` / `TEMP` / `/tmp`),
which is fine locally but does not persist on CI runners.

`SWAMP_EXTENSION_REVIEW_DIR` overrides the base, so CI can keep reports in a
repo-local path that persists across runners:

```yaml
# GitHub Actions example
env:
  SWAMP_EXTENSION_REVIEW_DIR: ${{ github.workspace }}/.swamp-reviews

steps:
  - uses: actions/checkout@v4
  - run: swamp extension push extensions/my-ext/manifest.yaml --yes
```

Precedence: `SWAMP_EXTENSION_REVIEW_DIR` > `TMPDIR` > `TMP` > `TEMP` > `/tmp`.
The `baseTmpDir` parameter on `reviewReportPath()`, used by tests, overrides all
env vars.

## Dependencies

Extensions can depend on other extensions. On pull, missing dependencies are
pulled automatically.

### Dependency Resolution

- The manifest lists dependencies by scoped name (e.g., `@keeb/network`).
- Each is checked against `upstream_extensions.json` and pulled recursively if
  not installed.
- Recursion stops at depth 10 to prevent circular dependency loops.
- An `alreadyPulled` set tracks extensions visited in one pull session to avoid
  repeat work.

### Workflow Dependency Resolution

During push, the CLI also finds the models a workflow references. It parses
workflow YAML for `model_method` and `workflow` step tasks and looks up the
model source files. Only user-collective models (types starting with `@`) are
bundled; built-in models are skipped.

## Automatic Resolution

Extensions from trusted collectives resolve on first use, without a manual
`extension pull`. When swamp meets an unknown model type from a trusted
collective, it searches the registry, installs the extension, hot-loads it and
carries on.

### Trusted Collectives

By default only the first-party `swamp` collective is trusted, so `@swamp/*`
extensions auto-resolve with no configuration.

Default trusted collectives: `["swamp"]`.

**Membership collectives are not trusted automatically** (swamp-club#465).
Membership lets you publish to a collective; it does not grant install consent
on the consumer side. A compromised or careless member's publish must
not be able to run code in every repo that uses the collective's types. Trust a
collective yourself:

```bash
swamp extension trust add myorg
```

which records it in `trustedCollectives` in `.swamp.yaml`:

```yaml
trustedCollectives:
  - swamp
  - myorg
```

Membership collectives are cached in `auth.json` during `auth login` and
`auth whoami`. `trustMemberCollectives: true` trusts every collective you
belong to (the old default); prefer trusting them one by one. Set
`trustedCollectives` to `[]` to turn off automatic resolution.

A trusted collective's extensions auto-resolve, but the installed version is
**pinned to the committed lockfile** (see
[Version pinning on auto-resolve](#version-pinning-on-auto-resolve) below). So a
trusted collective still cannot silently push an updated version into a repo.

#### CLI Management

Manage trusted collectives with the `swamp extension trust` commands:

```bash
swamp extension trust list                # Show explicit, membership, and resolved collectives
swamp extension trust add <collective>    # Add a collective to the trusted list
swamp extension trust rm <collective>     # Remove a collective from the trusted list
swamp extension trust auto-trust <on|off> # Opt in/out of trusting all membership collectives
```

`auto-trust` also accepts `true`/`enable` and `false`/`disable`
(`src/cli/commands/extension_trust_auto_trust.ts`).

### Version pinning on auto-resolve

If the extension already has an entry in the committed
`upstream_extensions.json` lockfile, auto-resolve installs the **pinned
version** and checks the download against the recorded **checksum**, instead of
fetching the latest (swamp-club#465). This is the same integrity-checked path
`swamp extension install` uses.

This matters on a fresh checkout, where `.swamp/pulled-extensions/` is
gitignored but the lockfile is committed. Without pinning, the first reference
to a type would silently fetch the latest version, letting a trusted collective
push an unreviewed update into the repo. Moving to a newer version takes an
explicit `swamp extension pull` / `swamp extension update`. If the checksum no
longer matches the registry (content drift), the install fails with guidance
instead of installing the changed bytes.

The first resolve (no lockfile entry yet) installs the latest version and
writes the entry, which then pins later resolves.

### Resolution Algorithm

1. **Local registry**: is the type already registered locally?
2. **Direct lookup**: try the full type as an extension name, then strip
   trailing segments for shorter candidates (e.g., `@swamp/aws/ec2/instance` →
   `@swamp/aws/ec2/instance` → `@swamp/aws/ec2` → `@swamp/aws`). For
   two-segment types like `@keeb/mongodb-datastore`, the full type is the only
   candidate; stripping more would leave a bare collective.
3. **Search fallback**: otherwise, search the registry for matching extensions.

### Safety: never overwrite on-disk extensions

Auto-resolution never overwrites an extension already on disk. If it is present
but its type failed to register, the problem is local, often a syntax error in
the user's unfinished edit, and a silent force-pull would destroy that work.

The resolver puts the pulled tree in one of four states, which decide what
auto-resolve does:

- **Missing**: no entry in `upstream_extensions.json`, or the directory
  `.swamp/pulled-extensions/<name>/` is absent and no source files the lockfile
  lists remain on disk. A clean install goes ahead.
- **Intact**: the lockfile entry, the directory and every file the lockfile
  lists are present. The resolver then checks the extension catalog for a
  failed source (`BundleBuildFailed`, `ValidationFailed` or
  `EntryPointUnreadable`) under the extension's directory, matched by path.
  - If one failed, or the catalog is unavailable, the failure is local. The
    resolver reports `alreadyInstalledButFailed` with the install path and the
    `--force` recovery command.
  - If none failed, the extension loaded but does not provide the type, usually
    because the installed version predates it (swamp-club#2476). The resolver
    reports `installedWithoutType`. When the registry has a newer CalVer
    version, it names that version and `swamp extension update <name>`. In JSON
    mode the event has `reason: "type_not_provided"` with `installedVersion`
    and `newerVersion`.
- **Truncated**: the lockfile entry and directory exist, but some listed files
  are missing (swamp-club#133). This "present but incomplete" state used to
  cause misleading `Unknown <kind> type` errors later. The resolver now reports
  `alreadyInstalledTruncated` naming the missing files, exits with an error, and
  does not try to repair. In JSON mode the event shape is:
  ```json
  {
    "event": "auto_resolve",
    "status": "failed",
    "extension": "...",
    "path": "...",
    "reason": "truncated",
    "missing": ["..."]
  }
  ```
- **Legacy**: the per-extension directory is absent, but source files the
  lockfile declares remain at older locations. Auto-resolution reports this and
  leaves the files alone. Run `swamp extension pull <name>` to accept the
  migration.

"Intact-but-fails" and "truncated" share one recovery,
`swamp extension pull <name> --force`, the only way auto-installation state can
overwrite a pulled extension. Legacy state needs an explicit
`swamp extension pull <name>` migration. No auto-resolve, validate or run
command will overwrite local edits, silently re-fetch a broken tree, or migrate
legacy files.

Truncation is checked per file: any file in the extension's lockfile entry that
cannot be stat'd. Only presence is checked, not contents.

Paths under `.swamp/bundles/`, `.swamp/vault-bundles/`,
`.swamp/datastore-bundles/` and `.swamp/report-bundles/` are excluded. They are
regenerable build artifacts, and clearing the bundle cache is routine. It must
not flip an extension with intact source into the truncated branch, which would
take over the user-WIP path from issue #121. Only source files in
`.swamp/pulled-extensions/<name>/` count.

### Hot-Loading

After installing, swamp re-runs model and vault discovery with
`skipAlreadyRegistered`, so only the new types load and types from startup are
not registered twice.

Hot-loading also re-attaches user extensions under `extensions/models/` that
`extend` a newly installed base type. The installer walks the catalog's
extension rows and calls the extension-attach primitive for each base that is
now fully registered. A user extension targeting `@swamp/aws/ec2/instance`
works as soon as auto-resolve pulls `@swamp/aws`, with no separate command.

### Re-Entrancy Guard

If auto-resolution is already running for a type, further attempts for it are
skipped, preventing infinite loops.

### Architecture

`ExtensionAutoResolver` is a domain service with port interfaces. CLI-layer
adapters implement registry access, extension installation and model/vault
discovery.

### Output

Auto-resolution always prints status: searching, installing, and a confirmation
with the number of models loaded.

## Safety

Every TypeScript file in an extension is checked before push and after pull.

### Hard Errors (block push/pull)

- Hidden files (names starting with `.`)
- File extensions other than `.ts`, `.json`, `.md`, `.yaml`, `.yml` and `.txt`.
  Files declared in `binaries` are exempt, as are the extensionless legal
  basenames in `LEGAL_BASENAMES` (`AUTHORS`, `CONTRIBUTORS`, `COPYING`,
  `COPYING-EXCEPTION`, `LICENSE`, `NOTICE`, `PATENTS`;
  `src/domain/extensions/extension_safety_analyzer.ts`).
- Symlinks
- A single file over 1 MB
- Total extension size over 10 MB
- More than 150 files
- Use of `eval()` or `new Function()` (code injection)

### Warnings (prompt user)

- Lines with more than 500 non-whitespace characters
- Base64-like strings (100+ consecutive base64 characters)
- Use of `Deno.Command()` to spawn subprocesses
- IPv4 address literals in `.md` and `.txt` files outside the RFC 5737
  documentation, loopback and link-local ranges (found by the extensible content
  rule framework)

### Binaries

The `binaries` manifest field declares executable host helpers. They skip the
file-extension allowlist but get every other check (hidden files, symlinks, size
limits, file count). On POSIX systems, executable mode bits survive publish and
pull.

On pull, the CLI warns the user to inspect declared binaries before use. The
list is also sent to swamp-club as push metadata for display on extension pages.

### Integrity Verification

Archives are verified with SHA-256 checksums, computed at push and stored in the
registry. Pull checks the downloaded archive against it. Legacy extensions from
before checksum support are marked "unverified" but still allowed.

### Archive Size Limits

Two limits in `src/domain/extensions/extension_archive_limits.ts` bound every
extension archive:

| Limit                                      | Value   | Bounds                                            |
| ------------------------------------------ | ------- | ------------------------------------------------- |
| `MAX_EXTENSION_ARCHIVE_BYTES`              | 50 MiB  | The compressed `.tar.gz`                          |
| `MAX_EXTENSION_ARCHIVE_DECOMPRESSED_BYTES` | 500 MiB | One decompressed read pass (tar headers + bodies) |

The compressed limit is enforced three times. The registry download counts
bytes as they arrive, and refuses an oversize `Content-Length` before reading
anything. `installExtension` checks it again before verifying checksums or
writing to the temp dir, so every download source is bounded, not just HTTP.
Push checks it in `extensionPushPrepare`, so `extension push`, `--dry-run` and
`extension quality` (when it packages a fresh archive) report an archive that
consumers could not download. Push does not check the decompressed limit.

The decompressed limit is a byte-counting stream placed right after gunzip in
`listTarGzEntries` and `extractTarGz`. The listing pass and the extract pass
each count separately, and going over the limit aborts either pass with
`ArchiveSizeLimitError`. This stops a small archive that expands to gigabytes
(a gzip bomb) from filling the temp dir.

Both values match the registry scoring analyzer's ceilings. The registry
enforces no size limit at publish time, so any archive the registry can score
still installs.

## Runtime Permissions

Extension model methods run inside the host Deno process (via
`InProcessExecutor`) and share the permissions compiled into the binary. The
binary uses individually scoped flags, not `--allow-all`, to keep privileges
minimal and avoid auto-granting future Deno permission categories:

| Flag            | Grants                                     |
| --------------- | ------------------------------------------ |
| `--allow-read`  | Filesystem reads (regular files)           |
| `--allow-write` | Filesystem writes (regular files)          |
| `--allow-env`   | Environment variable access                |
| `--allow-run`   | Subprocess spawning (`Deno.Command`)       |
| `--allow-sys`   | System info (hostname, OS, memory)         |
| `--allow-net`   | Network access (HTTP, TCP, UDP)            |
| `--allow-ffi`   | Foreign function interface (libc `getrlimit`/`setrlimit` for fd-limit raising at serve startup) |

`scripts/compile.ts` has the authoritative flag list.

### Device Node I/O

`Deno.open()` on character or block device nodes (e.g., `/dev/ttyUSB0`,
`/dev/spidev0.0`) fails in the compiled binary. Deno compiled binaries need
`--allow-all` for device nodes, even with `--allow-read` and `--allow-write`.
This is a Deno limitation, not a swamp one.

For hardware I/O, spawn a subprocess with `Deno.Command`, which `--allow-run`
permits:

```typescript
// Read from a serial device using cat
const cmd = new Deno.Command("cat", { args: ["/dev/ttyUSB0"], stdout: "piped" });
const { stdout } = await cmd.output();
const data = new TextDecoder().decode(stdout);

// Write to a serial device using dd
const write = new Deno.Command("dd", {
  args: ["of=/dev/ttyUSB0"],
  stdin: "piped",
});
const child = write.spawn();
const writer = child.stdin.getWriter();
await writer.write(new TextEncoder().encode("AT\r\n"));
await writer.close();
await child.status;

// Configure a serial port using stty
const stty = new Deno.Command("stty", {
  args: ["-F", "/dev/ttyUSB0", "115200", "cs8", "-cstopb", "-parenb"],
});
await stty.output();
```

Remote workers run bundles in-process with the same permissions as the CLI, so
this applies on every execution path.

## Dependency Trust Audit

During the push prepare phase, source files are scanned for `npm:` and `jsr:`
import specifiers. Each npm dependency is checked against trust gates adapted
from `@bixu/wheelshop`:

### Hard Errors (block push)

- Deprecated packages
- HIGH, CRITICAL or UNKNOWN severity vulnerabilities (via OSV.dev)

### Warnings (shown but don't block)

- MEDIUM severity vulnerabilities
- License not in the allowlist (MIT, Apache-2.0, BSD-2/3-Clause, ISC, 0BSD,
  MPL-2.0, Unlicense, CC0-1.0)
- No maintainers listed
- Weekly downloads below 1,000
- Last publish more than 24 months ago

### jsr Dependencies

jsr packages rely on jsr's own enforcement (SPDX license requirement,
provenance, no install scripts) and skip gates that lack data.

### Quality Rubric Factor

Dependency trust is a rubric factor (`dependency-trust`, worth 2 points) in both
`swamp extension quality` (CLI) and swamp-club's server-side scorer. It scores
when every dependency passes the trust gates with no hard errors.

## Registry

Extensions are distributed through the swamp registry at
`https://swamp-club.com`.

### Authentication

Push needs an API key in the `x-api-key` header
(`src/infrastructure/http/extension_api_client.ts`). Pull does not, but sends
the key when available so private or non-default registries can authorize it
(`src/libswamp/extensions/pull.ts`). Users can push only to their own
collective. `swamp auth login` authenticates to Swamp Club and provides the key.

`swamp extension yank <name> <version>` withdraws a published version from
resolution (`src/libswamp/extensions/yank.ts`). Deprecation, by contrast, leaves
versions pullable.

### Push Protocol

Push has three phases:

1. **Initiate**: `POST /api/v1/extensions/push` declares intent and returns a
   presigned S3 upload URL.
2. **Upload**: `PUT {uploadUrl}` uploads the tar.gz archive straight to S3.
3. **Confirm**: `POST /api/v1/extensions/confirm` finalizes the version.

### Pull Protocol

1. **Resolve**: `GET /api/v1/extensions/{name}` returns metadata and the latest
   version.
2. **Download**: `GET /api/v1/extensions/{name}@{version}/download` follows a
   302 redirect to the archive.
3. **Verify**: `GET /api/v1/extensions/{name}@{version}/checksum` returns the
   SHA-256 checksum.

## Upstream Extensions Tracking

On pull, the extension's metadata and extracted file list are recorded in
`upstream_extensions.json`. By default it lives in the models directory
(`<modelsDir>/upstream_extensions.json`). Repos on managed config keep it at
the datastore's resolved config base: `<path>/config` for a filesystem
datastore, the cache's `config/` for S3 or GCS, with the namespace in front of
`config/` when one is set (`<path>/<namespace>/config`;
`resolveManagedConfigPaths`, `src/cli/repo_context.ts`). On managed config,
pulled sources stay in the repo's `.swamp/config/pulled-extensions` whatever
the datastore; otherwise they live in `.swamp/pulled-extensions`. Until
swamp-club#2495, the auto-resolver in an S3/GCS managed repo records installs
in the in-repo `.swamp/config/upstream_extensions.json` instead, and readers
merge it in read-only (see datastores "Extension commands and the
chicken-and-egg", swamp-club#2483). The file supports clean removal, conflict
detection and **integrity-anchored restore** (see the `checksum` field below).

### Structure

```json
{
  "@keeb/ssh": {
    "version": "2026.02.26.1",
    "pulledAt": "2026-02-27T10:30:00.000Z",
    "checksum": "sha256-…",
    "filesChecksum": "sha256-…",
    "serverUrl": "https://registry.example.com",
    "channel": "rc",
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

Optional fields (`src/infrastructure/persistence/upstream_extensions.ts`):

- `filesChecksum`: a digest of the extracted subtree, so auto-update can detect
  local edits before overwriting.
- `serverUrl`: a non-default registry.
- `channel`: present only for non-stable installs.

Every entry records the archive's SHA-256 at install time (`checksum`). Each
lockfile-restore flow (`swamp extension install`, phase-two migration re-pull)
checks the fresh download byte for byte against it. On mismatch the restore
fails loudly with an error that offers a choice: accept the current registry
content (`swamp extension pull <name>`) or pin an older version. So the lockfile
is an integrity manifest as well as a version record, and restores cannot
silently accept changed registry bytes. Entries from before checksum tracking
(pre-commit `f4dfc083`) skip the check.

`swamp extension pull <name>` is how the user opts in to whatever the registry
now serves. Integrity checks apply only to lockfile-restore flows.

### Restore Reconciliation

`swamp extension install` decides per entry whether the disk already matches the
lockfile. File presence is not enough: another version's files may occupy the
per-extension subtree, left by an earlier pull or by `doctor extensions`
repairing a missing type. For each entry whose files are all present at the
current layout, install compares:

1. **Version**: the entry's `version` against the `version` in the installed
   `manifest.yaml` copy. A mismatch re-pulls the pinned version
   (swamp-club#2150). A constraint pin (`>=`, `^`, `~`) has no single version to
   match, and an entry installed before the manifest copy existed has no
   on-disk identity. Both go on to the content check rather than re-pulling on
   every run.
2. **Content**: the subtree digest against `filesChecksum`. This catches a
   lockfile updated through git without a matching re-fetch (swamp-club#1021).
3. **Dependencies**: each dependency the installed `manifest.yaml` declares
   against the lockfile, matched by name. A dependency with no entry re-pulls
   the parent, whose dependency loop installs it. Pull writes a parent's entry
   before installing its dependencies, so a dependency install that fails, or a
   hand-edited lockfile, otherwise leaves the dependency missing on every later
   restore (swamp-club#2646). A dependency that does not parse as an extension
   ref also re-pulls the parent, which then fails that entry. Such a dependency,
   or one the registry no longer serves, re-downloads the parent and reports it
   failed on every restore until the parent's manifest or the registry changes.
   A dependency removed with `extension rm` while a parent still declares it
   (rm warns about such dependents) is reinstalled by the next restore.

`doctor extensions --repair` restores the pinned version for the same reason:
re-pulling the latest would rewrite the entry and silently drop the pin.
Extensions with no lockfile entry have no pin and still resolve latest.

### Concurrency Safety

All changes to `upstream_extensions.json` take an advisory lockfile
(`upstream_extensions.json.lock`) with retries (10 attempts, 100ms backoff) and
use atomic writes, so concurrent operations cannot corrupt it.

That lock covers a single entry write. The rest of an install or removal (the
stage and swap of the extension's roots, the skills copy, orphan pruning, crash
recovery, the catalog save) is serialized per checkout by the
**pulled-extensions lock**
(`src/infrastructure/persistence/pulled_extensions_lock.ts`, swamp-club#2709).
Without it, two installs, or an install and an `extension rm`, can leave a mix
of two versions' files, prune files the other just wrote, or record an entry
that does not match the tree.

A section takes two layers: an in-process first-come-first-served mutex keyed
by the checkout, so concurrent `swamp serve` requests queue without polling,
then a `FileLock` on `.swamp/pulled-extensions.lock` for other processes. Its
TTL (30s) and heartbeat clear a crashed holder. A waiter's 180s budget covers
both layers: time queued behind a section in its own process, then time waiting
for another process's file lock. Past it, the waiter gets a `LockTimeoutError`
naming the lock file (and, when another process holds it, that holder). A
waiter that times out gives up its place in the queue without blocking the
sections behind it. `tryWithLock` reports busy instead of waiting.

Where it is held:

- **Install**: `installExtension` takes it around apply only. Prepare
  (registry lookup, download, checksum and safety checks) runs before it, so
  the extension's own download never holds up another process (a dependency's
  does; see below), and a `ConflictError` leaves the
  section before the CLI's conflict prompt. Every install path goes through
  `installExtension`: pull, update, the lockfile restore in
  `extension install`, auto-resolve, and the `swamp serve` admin handlers. One
  exception: when `extension install` migrates an entry from a legacy layout,
  it deletes the old-layout paths (`sweepLegacyPaths`) after `installExtension`
  returns, outside the lock. Those paths lie outside every extension's own
  subtree (`.swamp/pulled-extensions/<ext-name>/`, where names are scoped as
  `@x/...`), so no current-layout install writes them.
- **Catalog save**: `InstallExtensionService` runs its catalog save and the
  install's commit or rollback in the same section, through
  `installExtension`'s `underLock` hook.
- **Removal**: `RemoveExtensionService.execute` runs entirely under it.
  `extension rm`'s preview and confirmation prompt stay outside.
- **Dependencies**: dependency installs run under the parent's section, their
  registry lookups and downloads included. Whether a dependency needs
  installing is only known from the lockfile read under the lock.

Each section calls `LockfileRepository.refresh()` first, so the prior entry it
prunes against, and the other entries' claims `rm` checks, are the ones on
disk rather than the snapshot taken when the command started.

The lock is reentrant through an `AsyncLocalStorage` lease: a section entered
while the caller's lease for the same checkout is active runs inline. The lease
is deactivated when its section exits, so a promise created inside it that
enters a section afterwards has to take the lock.

**Lock order.** Take locks in this order, and never take an outer one while
holding an inner one:

1. the datastore global lock, when held (e.g. model validate, workflow
   evaluate);
2. `.swamp/.extension-install.lock` (auto-resolve, see
   [Auto-resolve safety](#auto-resolve-safety));
3. `.swamp/pulled-extensions.lock`;
4. `upstream_extensions.json.lock` (innermost).

Work that needs the datastore global lock around an install (swamp-club#2495)
takes it before the pulled-extensions lock, never inside apply.

The auto-resolve lock stays separate. It covers inspecting, downloading,
installing and loading, so a process that loses the race loads what the winner
installed. The pulled-extensions lock covers only the local changes, so an
explicit install is not held up by another process's download.

Reconcile from disk and bundle eviction do not take the lock. A reconcile that
runs inside an install's swap window (see
[Install Transaction](#install-transaction)) finds the extension's root briefly
absent. It records the extension's sources as `EntryPointUnreadable`, never
tombstoned, because the lockfile entry is still there, and the next reconcile
returns them to `Indexed`. Bundle eviction skips staging entries.

## File Extraction (Per-Extension Layout)

Each installed extension has its own subtree at
`.swamp/pulled-extensions/<ext-name>/`, where `<ext-name>` is its scoped name
(e.g. `@swamp/aws/ec2`). Per-type directories inside it mirror the archive:

| Archive directory    | Destination                                                    |
| -------------------- | -------------------------------------------------------------- |
| `manifest.yaml`      | `.swamp/pulled-extensions/<ext-name>/manifest.yaml` (ro)       |
| `models/`            | `.swamp/pulled-extensions/<ext-name>/models/`                  |
| `workflows/`         | `.swamp/pulled-extensions/<ext-name>/workflows/`               |
| `vaults/`            | `.swamp/pulled-extensions/<ext-name>/vaults/`                  |
| `datastores/`        | `.swamp/pulled-extensions/<ext-name>/datastores/`              |
| `reports/`           | `.swamp/pulled-extensions/<ext-name>/reports/`                 |
| `files/`             | `.swamp/pulled-extensions/<ext-name>/files/`                   |
| `bundles/`           | `.swamp/bundles/<bundleNamespace(per-extension models dir)>/`  |
| `vault-bundles/`     | `.swamp/vault-bundles/<bundleNamespace(…vaults dir)>/`         |
| `datastore-bundles/` | `.swamp/datastore-bundles/<bundleNamespace(…datastores dir)>/` |
| `report-bundles/`    | `.swamp/report-bundles/<bundleNamespace(…reports dir)>/`       |
| `skills/`            | Every enrolled tool's skills dir (deduplicated)                |

### Multi-tool skill materialization

In repos enrolled for several AI tools (`marker.tools` has 2+ entries),
`extension pull`, `extension update`, `extension install` and
`extension source add` extract skills to every enrolled tool's project-local
skills directory. Directories are deduplicated, so tools sharing a path are
written once. At project level, codex/opencode/copilot map to `.agents/skills/`
and cursor to `.cursor/skills/`. At the global (user-level) tier, cursor also
uses `.agents/skills/` (`SKILL_DIRS` / `GLOBAL_SKILL_DIRS` in
`src/domain/repo/skill_dirs.ts`).

Every skill copy is tracked in the lockfile's `files[]` array. So
`extension rm` deletes every copy, and re-pulling after a tool change prunes the
old tool's stale skill paths. A skill is tracked as its directory root when the
extension owns the dir: the install created it, or the prior entry already
listed the root. A skill merged into a dir that existed and that the extension
does not own is tracked file by file, so rm and the orphan prune delete only
what the extension wrote. The orphan prune does not treat a change between the
two forms as an orphan, and it keeps any path another lockfile entry claims.
Path comparisons for ownership ignore separator style and letter case, because
Windows-written lockfiles use backslashes and macOS and Windows filesystems are
case-insensitive (`src/domain/extensions/extension_path_claims.ts`).

The `resolveUniqueLocalSkillsDirs(repoDir, tools)` helper follows the
`resolveUniqueGlobalSkillsDirs(tools)` pattern used for user-level skill
directories.

### Why extension-first?

Sibling extensions from one collective (e.g. `@swamp/aws/ec2` and
`@swamp/aws/eks`) often ship files with the same basename: shared helpers under
`_lib/`, boilerplate like `README.md` and `LICENSE.txt`, and chance matches like
`cluster.ts`. In a type-first (flat) layout these collide on extraction. The
second pull either fails with `ConflictError` or, with `--force`, silently
overwrites the first. The silent overwrite is the dangerous case. Model bundles
import `_lib/*` helpers transitively, so swapping `_lib/aws.ts` between ec2 and
eks gives wrong runtime behavior with no type or load error.

In the extension-first layout, each extension's files live in their own subtree
keyed on its scoped name, so this cannot happen. The registry already uses the
scoped name as an identity value object; making it the filesystem aggregate root
only adds a path segment.

### manifest.yaml colocation

Each archive manifest is extracted to
`.swamp/pulled-extensions/<ext-name>/manifest.yaml` with mode `0o444`
(read-only) and a `# Read-only; regenerate via 'swamp extension pull'` header.
Every installed extension thus describes itself on disk, and `extension rm`'s
dependent resolution reads that manifest instead of re-fetching or re-parsing
the archive. Some filesystems (notably Windows) treat the read-only mode as
advisory. The header documents it; it is not a security boundary.

### Bundle cache isolation

`bundleNamespace(baseDir, repoDir)` hashes its input relative path. Each
extension has its own models dir, so each hash is unique and each extension gets
its own namespace under `.swamp/bundles/…` with no extra logic. In
datastore-backed repos where `bundles/` is tiered to S3 (see
`DEFAULT_DATASTORE_SUBDIRS`), team members' bundle caches stay separate per
extension.

If files exist at the destination and `--force` is not set, the user is asked to
confirm the overwrite. Since each extension has its own subtree, ConflictError
fires for those files only when an extension is reinstalled over itself.

Skills are the exception: they land in shared tool dirs, so a skill dir of the
same name may already belong to the user or to another extension. A skill dir
that exists and that the extension's prior lockfile entry does not list (as the
root or as files under it) is a ConflictError for the top-level extension.
`ConflictError.skillDirs` names those dirs, and the pull prompt and `--json`
output (`skillDirs`) list them apart from overwritten files, since the install
writes into them rather than replacing them. With
`--force`, and for dependencies, the install merges into the dir and logs a
warning naming it. The auto-resolver retries conflicts on pulled skill dirs with
force, as it does for stale bundle output.

macOS resource fork files (`._*`) cannot get into archives. The Deno-native
archiver in `src/infrastructure/archive/tar_archive.ts` walks an explicit file
list on push and filters AppleDouble entries on extraction, so no
`COPYFILE_DISABLE` environment variable is involved.

### Bundle staleness and recovery

A swamp upgrade that changes `BUNDLE_LAYOUT_VERSION` can leave bundles stale.
The `ExtensionLoader.buildIndex` invalidation guards detect the mismatch and
delete stale bundle files before reconciliation, so the `bundleWithCache`
fallback cannot reuse bundles built for an incompatible runtime.

Pulled extensions cannot re-bundle locally. They use bare specifiers (e.g.,
`from "zod"`) and ship without a `deno.json`, so `deno bundle` always fails and
they depend on the registry package's pre-built bundles. Once a stale bundle is
deleted, the extension enters `BundleBuildFailed` and is unavailable until
re-pulled.

Recovery paths:

- **`swamp doctor extensions --repair`** re-pulls pulled extensions in
  `BundleBuildFailed` or `ValidationFailed` state from the registry.
- **`swamp extension pull <name> --force`** re-downloads the extension and its
  pre-built bundle.
- **User-facing warning:** `registerLazyFromCatalog` warns when extensions are
  skipped for failure states and points to the recovery commands. It fires only
  if the source file exists; stale catalog entries for deleted sources are
  skipped silently (swamp-club#894).

Bump `BUNDLE_LAYOUT_VERSION` whenever a change to the bundler, runtime interface
or zod global shape makes existing bundles incompatible.

## Install Transaction

An install replaces an extension's files by **stage and swap**
(`ExtensionInstallTransaction` in
`src/infrastructure/persistence/extension_install_transaction.ts`, the journal
and recovery rules in `src/domain/extensions/install_journal.ts`,
swamp-club#2723). It used to copy the new version over the live one file by
file. That left a mix of two versions' files after a crash and could not be
undone.

**Roots.** The swap moves whole directories: the extension root
`<pulledRoot>/<name>/` and each of its bundle namespace dirs
`.swamp/<kind>-bundles/<ns>/`, including one that neither exists nor gets files
from the new version: the catalog save's loaders write bundles into it after
the swap, and a rollback must remove them. Skills are not swapped. A skill dir
can be shared with the user or another extension, so skills keep the merge copy
and `createdPaths` rules in
[Multi-tool skill materialization](#multi-tool-skill-materialization), and sit
outside the guarantees below: a rolled-back install can leave the new version's
content in a skill file it overwrote. Skill orphans are pruned only when the
install commits, so a rollback finds the previous version's skill files still
there and a failed install never leaves an entry claiming a deleted skill file.
The prune reads the claims at commit: a dropped skill dir that a dependency
installed in the same call merged files into is walked, and only the files no
entry claims (in either direction: an entry listing the file, or a dir above
it) are removed. The walk descends plain dirs only, never a symlink, and
removes a link itself, never its target.

**Staging.** Each root's new and old copies live in a staging dir next to it,
so every rename stays on one filesystem:

- extension root: `<pulledRoot>/.swamp-staging/<stagingId>/{new,old}/0`;
- bundle root: `.swamp/<kind>-bundles/.swamp-staging-<stagingId>/{new,old}/<i>`.

A reader that lists the pulled root or a bundle kind dir must skip
`.swamp-staging*` entries (`isStagingEntryName`). Most readers get extension
names from the lockfile or keep only `@`-prefixed entries, so they never see
them. `doctor extensions` bundle enumeration, the vault bundle preload for
datastore expressions, bundle eviction, the managed-config migration copy and
`directory_merge` skip them explicitly.

**Journal.** Before any staging dir exists (only the dir that holds it),
the install writes `<pulledRoot>/.swamp-staging/<stagingId>/journal.json` with an atomic
write. It records the owner id, the stagingId, the absolute repo dir, the
extension name, the phase
(`staged` or `swapped`), the lockfile path the install writes, the new archive
checksum, the old and new manifest digests, every root (live, old and new
paths, whether the live root existed and whether it was a symlink, whether the
new version has files for it), and the nested entry roots carried over. A bundle
root may have neither existed nor have new files; the extension root always has
new files. A binary from before swamp-club#2724 rejects such a journal as having
"nothing to swap" and leaves it with a warning, so after a downgrade in the middle
of an interrupted install that extension stays blocked until the journal is
settled by a current binary or resolved by hand.

**Swap.** Phase 1 moves each existing live root to `old/<i>`. Phase 2 moves
each new root into place, bundles first, then the extension root (staged
without `manifest.yaml`), then `manifest.yaml` last. A bundle cache dir that a
loader outside the lock recreated since phase 1 is moved aside into staging
first, not treated as a failure. The journal then records
`swapped`. Any failed rename undoes the completed ones in reverse order,
carrying on past a step that cannot be undone (a bundle dir a loader recreated)
so the other roots still go back. Before
each phase the install re-reads the journal and stops unless it still owns it.
No rename ever targets an existing path, so Windows never renames over a
directory. Between the first phase-1 rename and the `swapped` write only
renames, lstats and journal reads and writes happen, so the window in which a
root is absent to readers outside the lock stays short.

**Commit or rollback.** `applyInstall` returns a `PendingInstall`: the swap is
done and the old roots are kept. It covers the extension and every dependency
installed with it, which stay uncommitted too (their owner ids stay active, so
a later dependency's recovery leaves their journals alone). Exactly one of
`commit()` and `rollback()` takes effect; calling either again does nothing.
The caller of `installExtension` ends it in its `underLock` hook, still under
the lock (see
[Commit or rollback after the catalog save](#commit-or-rollback-after-the-catalog-save));
`installExtension` commits one left pending, and commits right after apply when
there is no hook (the lockfile restore in `extension install`, auto-resolve
without a catalog). If apply fails after some dependencies were applied, they
are committed and the parent rolls forward, since its entry has landed.

- **Commit** deletes the staging, and with it the old roots, dependencies
  first, then prunes the skill orphans. Deleting staging removes the journal
  first, so a crash part-way through leaves journal-less staging for the sweep,
  never a journal that could later restore a half-deleted old root. Warnings
  about what the install replaced or removed under the extension root are
  logged here, once they are final.
- **Rollback** (`ExtensionInstallTransaction.rollback()`) plans each root with
  the crash recovery planner, forced back, and runs the same renames through the
  same helper (`applyRecoveryRenames`). The one addition: a bundle cache dir a
  loader recreates between moving the new copy aside and the old one back is
  moved to a free path under `superseded/` in staging and the rename retried
  once. Staging is then deleted, journal first. A root it cannot account for,
  or a rename that fails, leaves the journal for crash recovery.

**Settle.** Any failure after staging starts is settled before it propagates,
by the same rule as crash recovery: forward when the journal reached `swapped`
and the lockfile entry landed (a dependency failed after the parent was
written), back otherwise. In process the install knows whether its own lockfile
write completed, so a failed same-version reinstall rolls back even though the
prior entry already carries its checksum. Settle never replaces the original error. If settle
itself fails, the journal stays for crash recovery.

**Crash recovery.** `recoverPulledExtensionStaging(repoDir)` runs under the
pulled-extensions lock at the start of every apply and every removal. Other
callers, such as convergence, can call it directly. For each journal whose
owner is not an install running in this process (no pid checks: containers
reuse pids):

- The journal is validated first. Every path must be exactly the one derived
  from the extension name and the stagingId, and the lockfile path must be one
  this checkout can write (`resolveExtensionLockfilePaths`, including the
  non-managed `extensions/models/upstream_extensions.json`). An invalid journal
  is left in place with one warning naming it.
- It rolls forward when the journal reached `swapped` and the recorded
  lockfile's entry carries the new checksum; otherwise back. Rolling forward
  checks that the extension root and its manifest are the new ones, not
  whether a bundle root is live: loaders outside the lock rebuild and evict
  bundle caches.
- Rolling back, each root is judged from where its original is: in `old/<i>`
  once phase 1 moved it aside, otherwise still live. Where the new copy is
  does not matter, so a crash inside `begin` or during cleanup stays
  recoverable, and a live dir found next to a moved-aside original (a bundle
  cache a loader recreated) is superseded. Never from the extension's
  manifest. Recovery only renames; a superseded root goes to `discard/<i>` and
  is deleted with the staging, so the only copy of a root is never deleted.
- An original that is gone, a symlink or file where a directory belongs
  (including any staging dir or a dir above a live root, but not an extension
  root recorded as a symlink, see below), or a failed
  recovery leaves the journal in place with a warning. While such a journal
  names an extension, installing or removing it, or an extension nested in or
  above it, is refused with a message naming the journal: changing its roots
  first would let a later recovery act on files it did not write. The
  refusal's advice follows what recovery found at the extension root and at
  `old/0`: move the previous version back when only it is left, keep the
  wanted one when both exist, check the live root when nothing is staged,
  pull again when neither exists. It never says to delete staging that may
  hold the only copy.
- Journal paths are absolute, derived from the absolute repository path. A
  journal written under another repo dir (the repo was moved or copied, a CI
  workspace was restored at another path, a container mounts it elsewhere, or
  a symlinked spelling such as macOS `/tmp` and `/private/tmp`) is rebased
  first: each path under the recorded repo dir moves under the current one,
  and a path outside it (a lockfile kept outside the repo) is kept. The exact
  validation then runs on the rebased journal, so the rebase only accepts a
  journal that could have been written with the current paths, and a copied
  checkout recovers its own files, never the original's.
- Staging with no journal is swept only once it is older than an hour.

Recovery never writes the lockfile. A same-version reinstall has equal old and
new checksums, so after a process crash (not a failure the install settles
itself) between `swapped` and the lockfile write, recovery rolls forward. The tree is then the reinstalled one with the old entry, identical
apart from any files it could not carry forward (see below).

**Extra files.** The swap replaces a root whole, so the install copies
the files a user added under `.swamp/pulled-extensions/<name>/` into the
new root, keeping their times, as the merge copy kept them. `extension
update`, `extension install` and `repo upgrade` install with force, so
this is what keeps those files, not the local-edits guard. A file is the
user's when the new archive does not ship it and the prior lockfile
entry's `files[]` does not list it. A file the entry lists is one the
prior version shipped and the new one dropped, so it goes with the old
root, and an upgrade never leaves a mix of two versions' files. Where the
archive ships a file at the same path, the archive's copy wins (a
`ConflictError` without `--force`, as before). The user's files stay out
of `files[]`; `filesChecksum` is the digest of the tree on disk, theirs
included, as before.

The entry's list only describes the tree when the installed
`manifest.yaml` is the entry's version. When it is not (a lockfile
restored from git after an upgrade), or the entry has no `files[]`, or
there is no entry, unlisted files cannot be told apart from ones an older
version shipped. The install then keeps only what the archive ships and
logs a warning naming each file it removed. A symlink, or a path under
one where the new archive ships a file, cannot be copied and is named in
a warning the same way. No file under the root is removed without either
being listed in the prior entry or named in a warning.

**Symlinked extension root.** An extension root that is a symlink is replaced,
not written through. Phase 1 moves the link itself to `old/<i>`, the new
version goes in as a real directory, and commit deletes the link with the
staging; the link's target is never read or written by the swap. Files in the
target are not carried forward. Once the lockfile entry is written, a warning
names the link and its target and says to re-create the link to keep using it.
A failure or a crash puts the link back where it was: the journal records
`liveIsLink`, and recovery treats the link as the original in the `old` and
live slots. A bundle root that is a symlink is still refused.

**Nested entries.** A scoped name can nest another (`@a/b` contains the root of
`@a/b/c`). An install of `@a/b` copies each nested entry's root into its new
root, keeping file and directory times so the nested entry's sources stay no
newer than its pre-built bundles, and records it in the journal. A nested entry
whose first path segment is a kind dir or `manifest.yaml` (`@a/b/models`) is
refused, whichever of the two is installed second: the parent's own files live
there, and the swap would move them aside and commit would delete them. Such a
layout installed before this change; remove one of the two to install the
other. The installed-extension digest (`filesChecksum`) leaves nested entry
roots out, so installing `@a/b/c` does not make `@a/b` look locally edited. A
digest stored before this rule covered the nested root too. While a root has
nested entries, the local-edits check and the `extension install` content check
also accept that whole-tree digest, until the next install stores the new one.

**Not protected.** The pulled-extensions lock is per host. Two hosts that
mount one checkout on a shared volume can still interleave, and one host's
recovery can roll back the other's install in flight. A crash-leftover
staging dir under `.swamp/config/pulled-extensions` in a managed-config repo
can be pushed by a full sync before the next install or removal recovers it.
Rolling back an interrupted first install moves aside whatever is at the live
root; if a swamp without this change, or another host, installed the extension
there in between, recovery discards that install while its lockfile entry
stays.

## Layout Migration

Repos with extensions under older layouts migrate with `swamp repo upgrade`.
Three generations are recognised:

- **gen-1 (pre-`.swamp/`):** files under `extensions/<type>/...`. Handled like
  gen-2: `swamp extension install` re-pulls into the per-extension subtree and
  `sweepLegacyPaths` removes the tracked legacy paths
  (`src/libswamp/extensions/install.ts`). Nothing is renamed in place.
- **gen-2 (flat under `.swamp/`):** files under
  `.swamp/pulled-extensions/<type>/<file>`. Filenames collide across extensions
  here, so earlier installs may have overwritten each other and renaming cannot
  recover the real content. `repo upgrade` instead deletes each gen-2 entry's
  tracked files and leaves the lockfile unchanged. The next
  `swamp extension install` re-pulls each affected extension into its new
  subtree, verified against the lockfile's stored checksum.
- **current (per-extension):** files under
  `.swamp/pulled-extensions/<ext-name>/<type>/...`. No migration needed.

The lockfile tolerates mixed generations, since each entry stands alone. The CLI
guard warns with a one-line reminder instead of failing, so migrated extensions
stay usable during a partial upgrade. The migration is resumable:
`Deno.errors.NotFound` during the delete counts as success, as expected on a
retry after an interrupted run. Any other IO error stops the upgrade before
further changes and leaves the lockfile intact, so a retry starts from a
consistent state.

Skill directory entries are always treated as current-layout, wherever they
are. Each is tracked as one dir path in `entry.files[]`, e.g.
`.claude/skills/<name>`, `.cursor/skills/<name>`, or
`.swamp/pulled-extensions/skills/<name>` for the `tool=none` fallback. The
install flow filters them out before classification, using the skillsDir passed
through `ExtensionInstallDeps`. They never trigger migration on their own and the
post-migration sweep never touches them. Without the filter, the `tool=none`
path would look like a gen-2 path and the freshly restored skill dir would be
deleted. On its own, the path-only `classifyExtensionFile` helper flags only the
documented gen-1 shape, `extensions/<known-type>/...` with `<known-type>` in
`PULLED_TYPE_DIRS`. Any other non-`.swamp/` path, or a path it doesn't
recognise, counts as current-layout and is ignored rather than swept.

## Removal

`extension rm` first runs crash recovery (see
[Install Transaction](#install-transaction)), so the files it removes are the
ones the lockfile describes. It then checks that every file tracked in `upstream_extensions.json`
resolves inside the repository. If any path does not, for example in a lockfile
written before `.swamp/` existed with `SWAMP_MODELS_DIR` outside the repo, rm
fails with nothing changed and names the paths to remove from the entry.

It then tombstones the extension's catalog rows, freeing its `(kind, type)`
slots atomically in one SQLite transaction. After that it removes the lockfile
entry, deletes the tracked files, and prunes empty parent directories. A file
that cannot be deleted, for example because of a permission error or a file
locked on Windows, does not stop the rm. It is listed in `failedFiles` for the
user to remove by hand, since nothing tracks it any more. A tracked path that
another installed extension also claims (a shared skill dir that extension
lists, or lists files under) is kept and reported in `retainedFiles`. Tracked
paths are checked with `lstat`, so a symlink is unlinked rather than followed.

If other installed extensions depend on the target (found by scanning their
`manifest.yaml` files on disk), a warning is shown first.

A second rm of the same extension gives a clean
`Extension <name> is not installed.` user error. The lifecycle service decides
"not installed" only when both the catalog and the lockfile show it absent, so
extensions in a partial state still rm cleanly.

Extensions pulled before file tracking existed cannot be removed cleanly; the
user is asked to re-pull with `--force` to fill in the file list first.

## Lifecycle Services

`InstallExtensionService`, `RemoveExtensionService` and
`UpgradeExtensionService` (in `src/libswamp/extensions/`) are the only three
paths that write the catalog. CLI command files never call the catalog directly;
they build the service and call `execute(...)`. This split lets `rm` prune
catalog rows, and the unified loader builds on it.

### Asymmetric ordering

Install is **filesystem → lockfile → catalog**. Remove is the inverse:
**catalog → lockfile → filesystem**, preceded by a path check that changes
nothing when it fails.

If rm deleted files first, the catalog would briefly point
at deleted bundle files and concurrent type resolution would crash. With the
catalog first, a crash mid-rm leaves files on disk but a clean catalog, and the
next loader pass finds the orphans via `findStaleFiles`. With the catalog last
on install, a crash mid-install leaves files and the lockfile entry but no
catalog rows, and the next loader pass rebuilds them through the cold-start
path.

### Phase 8: synchronous type extraction at install

After writing files and the lockfile entry, phase 8 walks the per-extension
subtree and calls each loader's `bundleAndIndexOne(args)` on every source file.
It builds an `Extension` aggregate whose Sources are `Indexed` with
`(kind, typeNormalized, bundlePath)` set, and commits it with
`repository.saveAll([extension])` in one SQLite transaction. The repository's
I-Repo-1 invariant (no two non-tombstoned Sources share
`(kind, typeNormalized)`) is therefore checked at install, not at the next
steady-state loader pass. A type collision between extensions shows up as a
clean `DuplicateTypeUserError` before the user sees "successfully pulled".

`bundleAndIndexOne` is a strict per-loader contract: it bundles, extracts types
and returns metadata, but **does not write to the catalog**. Only the lifecycle
service writes the catalog, which keeps I-Repo-1 firing consistently on every
install.

### Unreachable-path pre-flight prune

Before checking I-Repo-1, `saveAll` prunes non-Tombstoned rows whose
`source_path` is outside the canonical repo root. These are stale rows from
container sessions that bind-mounted the repo elsewhere (e.g. `/workspace/...`
vs `/Users/...`). Unpruned, these phantom rows cause cross-aggregate
`(kind, typeNormalized)` collisions that block every catalog write, including
`rm` of unrelated extensions.

### Stale-source pre-flight prune

In the same step, `saveAll` also deletes rows that could only mislead type
resolution (`ExtensionCatalogStore.pruneStaleSources`, swamp-club#2490):

- a row that claims a type (or, for an extension row, a base type) whose source
  file is missing. Only `NotFound` counts as missing. Importing such a row
  either fails with ENOENT when its bundle is rebuilt, or silently runs an old
  bundle;
- when the repo's active pulled root is known, a row under the other pulled
  root, `.swamp/pulled-extensions/` or `.swamp/config/pulled-extensions/`.
  `datastore config migrate` copies the pulled tree rather than moving it.
  Datastore rows are exempt: the on-disk datastore chooser can load from either
  root, and `purgeUnchosenPulledDatastoreRows` decides which one survives.

Rows in the save, Tombstoned rows and rows in a failure state
(`CATALOG_FAILURE_STATES`, kept so doctor can report them) are never deleted.
Deletion uses the raw stored path, so keys written on another OS still match.
The prune runs before I-Repo-1, so a typed row whose source is gone no longer
blocks another extension from claiming its type. A copied old-root row no
longer shares a type with its new-root twin either, which used to roll back
every unrelated save. Like the unreachable-path prune, it is skipped when the
caller passes `pruneUnreachable: false`. Once the transaction commits, each
removed row's bundle is deleted, unless the row's source still exists under
another spelling of the repo root or another row still references the bundle.

### Stale-source healing

The loader keeps its own catalog writes consistent with the rules above, so a
stale row never crashes a command (swamp-club#2490):

- **Identity.** `deriveExtensionIdentity` recognizes both pulled roots, so
  `extension rm` finds and tombstones rows under
  `.swamp/config/pulled-extensions/`. `computeExtensionRoot` still roots every
  pulled aggregate under `.swamp/pulled-extensions/<name>`, so two roots in one
  aggregate never trip I1.
- **Unseen rows.** The cold path of `buildIndex` removes rows its scan no longer
  reaches, exactly as `findStaleFiles` does on the warm path. Both use the same
  discovery and exempt failure states. Rows under an old pulled root, or rows
  of an extension that is no longer installed, do not outlive a cold pass.
- **Type-load guard.** `loadSingleType` checks that a row's source exists before
  importing its bundle, whether or not the bundle exists. A row whose source is
  gone is deleted, and the next row claiming the type is tried. With none left,
  the registry reports the type as not found. The model adapter filters
  extension rows the same way. Every kind registry drops a lazy entry that its
  loader did not promote.
- **Conflict settle.** A rebundle never writes a type that a higher-ranked row
  already holds: a local row outranks a pulled one, and a pulled row that holds
  the type outranks any other pulled row. A cold index discovers files in
  sorted order, so there the smallest path is indexed first and wins. After
  each pass, pulled rows that still share a `(kind, type)`, as an older binary
  could leave them, are settled by insertion order: the earliest row keeps the
  type (`settlePulledTypeConflicts`), which is the row that binary resolved.
  Pulled-vs-local conflicts are then resolved (`resolveOriginConflicts`), so a
  local override ends up the only claimant.
  `saveAll` settles pulled conflicts only when asked
  (`settlePulledTypeConflicts: true`), which only ReconcileFromDisk does: a
  conflicting install still fails with `DuplicateTypeError`. The loader and the
  reconcile report a settled conflict with the same warning, once per process.
- **Typeless-row heal.** A row whose type was cleared for a conflict keeps an
  empty type after the winning row is gone, because its fingerprint still
  matches. The per-kind `bundle_meta` marker
  `migration_applied:typeless-row-heal-v1:<kind>` is absent after an upgrade
  and is cleared whenever a row that claims a type is deleted or upserted with
  a different type. While it is absent, the next warm pass imports the existing
  bundle of each seen, typeless `Indexed` row, and of each row it wrote
  typeless in the same pass, to learn its type. It writes the type back only
  when no row claims it, for at most one row per type: a local row before a
  pulled one, then the smallest path. The pass then sets the marker. This
  writes the catalog only and never the registry, so a pulled row cannot
  displace a local override. The heal is also skipped, with the marker left
  unset, while the kind has a local row in a failed state whose source still
  exists: a failed row claims no type, so a broken local override would
  otherwise hand its type to the pulled row it shadows. The heal runs once that
  row is fixed or its file is removed.

### Atomic upgrade pattern

For each new aggregate it saves, the install service tombstones any existing
aggregate with the same name but a different version, and submits everything
to `saveAll` in one transaction:

```
saveAll([tombstoneAll(v1), ..., v2])
```

I-Repo-1 checks the post-save state, where only the new version holds the slot.
Without this pattern, a force-pull of an installed extension, or any
version-bump pull, would fail with `DuplicateTypeError` against the user's own
earlier version. Reinstalling the same version skips the tombstone; the
diff-save in `saveAll` handles the overwrite.

`UpgradeExtensionService` is a thin facade over
`InstallExtensionService.execute(...)` so call sites can state upgrade intent.
The atomic-tombstone logic lives in the install service's phase 8.

### Commit or rollback after the catalog save

Phase 8 receives the install uncommitted, as a `PendingInstall` (see
[Install Transaction](#install-transaction)): the previous versions of the
extension and of every dependency installed with it are still kept aside.
`InstallExtensionService` ends it under the lock (swamp-club#2724):

- **The catalog save succeeds**: commit.
- **`DuplicateTypeError`** (two different extensions claiming the same
  `(kind, typeNormalized)`): rollback. SQLite ROLLBACK has already undone the
  catalog, so the previous versions' rows are still there; the rollback puts
  the files back to match them:
  1. Every lockfile entry the install wrote is restored in **one write**
     (`LockfileRepository.restoreEntries`): the prior entry object exactly as it
     was read, or no entry where there was none. The write is under the
     advisory lock, and the entry is not rebuilt, so file order, empty fields
     and unknown keys come back as they were.
  2. Every root is moved back, dependencies first, in reverse install order.
  3. The skill paths the install created are deleted. A skill dir that existed
     before the install is never deleted: only the files the install newly
     wrote in it are removed, and files it overwrote keep their new content.

  The entries go back before any root, so a crash in between leaves journals
  whose lockfile entry is not their install's, and recovery rolls each one
  back. An upgrade that collides therefore leaves the previous version
  installed exactly, files, bundles and lockfile entry.
- **Any other fault** (a source that fails to bundle, a generic `saveAll`
  failure): commit, then the "Install partially applied" message (see
  [Crash-state recovery](#crash-state-recovery)).

If the lockfile write reports an error, the rollback reads the lockfile back:
releasing the advisory lock runs after the write, so an error does not prove
nothing landed. Where every entry was restored it carries on. Where none was, it
commits the whole install and reports `kept`: files, lockfile and dependencies
stay consistently on the new version, the half-state of a generic fault plus an
unresolved collision, which the next loader pass settles first-wins. Where the
lockfile cannot be read back, or holds neither the restored entries nor the new
ones, it leaves every journal for the next install or removal to settle from the
lockfile then, and reports `unsettled`. A root the rollback cannot move back
(a disk state it cannot account for, or a failed rename) also reports
`unsettled`: its journal stays, its lockfile entry is already restored, and the
next recovery rolls it back, or leaves it with a warning naming the journal when
the disk state still does not match any it can produce.

The error then propagates as a `DuplicateTypeUserError` (a `UserError`
subclass). The top-level CLI handler prints a clean one-line message in log mode
and a structured `duplicateType` object in `--json` mode:

```json
{
  "error": "Type \"@scope/foo\" (kind=model) is already claimed by ...",
  "duplicateType": {
    "kind": "model",
    "type": "@scope/foo",
    "isGhostRow": false,
    "rolledBack": true,
    "rollback": { "status": "rolled-back" },
    "existing": {
      "extensionName": "...",
      "extensionVersion": "...",
      "canonicalPath": "..."
    },
    "conflicting": {
      "extensionName": "...",
      "extensionVersion": "...",
      "canonicalPath": "..."
    }
  }
}
```

`existing` is the extension that already held the type in the catalog and
`conflicting` is the one being installed, regardless of how their paths sort:
the repository decides this from which sources are in the failing save, not
from catalog row order.

`rollback` says how the rollback ended: `rolled-back` (with `reverted`: each
extension's name, the version it tried and its prior version), `kept` (the same,
as `kept`) or `unsettled` (with the lockfile path); `rolledBack` is true only for
`rolled-back`. A `rolled-back` message names the version that remains installed
when the extension had one ("rolled back; `<name>@<prior>` remains installed").
A `kept` message says the install was kept rather than "Cannot install", and
suggests `swamp extension pull <name>@<prior>` for each kept extension that had a
prior version, `swamp extension rm <name>` for one that did not, or removing the
extension that already held the type (or `swamp doctor extensions` when that is
a ghost row). An `unsettled` message says the next `swamp extension` install or
removal will finish the rollback or name the install journal to resolve by hand;
the lockfile path is in the JSON only.

`extension update` reports an update whose collision left it `kept` as
`kept_with_collision` (previous and new version, and the error), counted apart
from `updated` and `failed` in the summary (`keptWithCollision`).

The message suggests `swamp extension rm <existing-name>`. A conflict may come
from a **ghost catalog row**, whose source file was deleted outside swamp. The
service then stats the `existing` side's path via `Deno.stat` and suggests
`swamp doctor extensions` instead, the right fix for orphaned rows. The
`isGhostRow` flag on `DuplicateTypeUserError` is then `true` and appears in the
`--json` output's `duplicateType` object.

### Bounded atomicity

Each `execute(...)` is its own transaction. Bulk operations (`extension update`
over N extensions) run N separate transactions, not one all-or-nothing batch. If
extension A's upgrade rolls back on a collision with unchanged extension B,
extensions already upgraded in the run stay upgraded. The unit of atomicity
is one extension, never a multi-extension run.

### Crash-state recovery

A crash during the file changes of an install is put right by the next install
or removal: the journal lets recovery roll the swap forward or back (see
[Install Transaction](#install-transaction)), so the extension root and its
bundle dirs are always one version's, never a mix. Skill files are outside that
guarantee.

Any failure other than `DuplicateTypeError` inside `repository.saveAll` (SQLite
I/O error, OOM, process killed mid-commit) leaves the catalog in its pre-save
state via SQLite ROLLBACK. The install then commits, so the filesystem and
lockfile hold the new version; only `DuplicateTypeError` rolls the install
back. A source that fails to bundle during phase 8 commits the same way, so one
source that cannot import on this machine does not stop the rest installing. A
retry succeeds, because the diff-save in `saveAll` reconciles the catalog with
the disk and lockfile.

A process killed while phase 8 holds the install uncommitted leaves a journal
that reached `swapped` with its lockfile entry landed, so the next recovery
rolls it forward: the same half-state as a generic fault.

Known crash edges the recovery leaves for a person, with the journal named:

- A same-version reinstall over a symlinked extension root that collides, then
  crashes after its rollback renames: the entry carries the new checksum, so
  recovery plans forward and finds the restored link where it expects the new
  directory.
- A rollback that crashes after moving a previously absent bundle root's new
  copy to `discard/<i>`, followed by a loader recreating that bundle dir.

For rm, the catalog tombstone is the first change, so a fault in that
`saveAll` leaves catalog, lockfile and FS in their pre-rm state and a retry is a
clean re-rm.

Known limit: these per-extension atomicity guarantees are reasoned about per
process. No automated
stress test covers concurrent `swamp` processes changing one repository
(parallel `pull`/`rm`/`update`).

### Unified loader

One `ExtensionLoader` (`src/domain/extensions/extension_loader.ts`),
parameterized by a `KindAdapter` (`model_kind_adapter.ts`,
`vault_kind_adapter.ts`, `datastore_kind_adapter.ts`,
`report_kind_adapter.ts`), gives one `bundleAndIndexOne` dispatch for all four
kinds. The install/remove/upgrade services keep their public API, and CLI
command files (`extension_pull.ts`, `extension_update.ts`, `extension_rm.ts`,
etc.) build them directly.

### ReconcileFromDisk and freshness as an aggregate query

`ReconcileFromDiskService`
(`src/libswamp/extensions/reconcile_from_disk_service.ts`) and the freshness
contract form two layers:

1. **Type resolution layer**: `isFresh(state) = state === "Indexed"`, a
   constant-time aggregate query. Type resolution ignores all other RowState
   tags.

2. **State maintenance layer**, split between two paths:
   - **Cold-start / explicit reconcile:** `ReconcileFromDiskService` walks the
     whole disk across all three origin types (locals, pulled, source-mounted)
     and repairs state after the fact. It runs when
     `anyKindNeedsInvalidation()` returns true, i.e. some kind's
     `populated:<kind>` marker in `bundle_meta` is unset.
   - **Warm-start / hot path:** `findStaleFiles` compares fingerprints
     incrementally, run by each loader's `buildIndex` once the catalog is
     populated. It deletes rows whose source it no longer sees, except those in
     a failure state; the cold path applies the same removal
     (`removeUnseenCatalogRows`). A `BundleBuildFailed` row with a matching
     fingerprint counts as stale and is retried on the next scan, not treated
     as a cache hit. A transient build failure (e.g. npm deps unreachable on a
     cold cache at first load) must recover when conditions change, not block
     the type across restarts. Deterministic `ValidationFailed` rows stay excluded,
     since re-bundling them only wastes work.

The development workflow depends on warm-start incremental detection, so
`findStaleFiles` keeps its full fingerprint comparison rather than becoming a
deletion-sweep shim.

**ReconcileFromDisk semantics.** The service:

- Walks the on-disk source trees for all origin types.
- Loads current aggregate state via `repository.loadAll()`.
- Diffs disk against the aggregate and emits RowState transitions with the
  existing Extension aggregate methods.
- Uses each loader's `bundleAndIndexOne` for type extraction, not
  `InstallExtensionService`: the source and lockfile already exist, and
  reconcile only repairs state.
- Saves via `repository.saveAll()` in one SQLite transaction, with
  `settlePulledTypeConflicts: true`. Two pulled extensions that provide the same
  `(kind, type)` are settled the way the loader settles them, not rejected: the
  earliest-inserted row keeps the type, and a warning names both extensions.
  On a rebuilt catalog that is the entry listed first in the lockfile. Without
  this, the reconcile rolled back and left the catalog empty, so every later
  command failed the same way (swamp-club#2702). Duplicates among local and
  source-mounted extensions still throw `DuplicateTypeError`.

**Locals vs pulled reconcile matrix:**

| Origin         | Source on disk | Source in aggregate | Transition                                                 |
| -------------- | -------------- | ------------------- | ---------------------------------------------------------- |
| Local          | present        | absent              | `bundleAndIndexOne` → `Indexed`                            |
| Local          | absent         | present             | `markSourceMissing` → `OrphanedBundleOnly` or `Tombstoned` |
| Pulled         | present        | absent              | `bundleAndIndexOne` → `Indexed`                            |
| Pulled         | absent         | lockfile present    | `recordEntryPointUnreadable` (no automatic re-fetch)       |
| Pulled         | outside walk   | lockfile present    | `Tombstoned` (e.g. the pre-migrate copy, swamp-club#2490)  |
| Pulled         | absent         | lockfile absent     | `Tombstoned` (orphan from failed rm)                       |
| Source-mounted | —              | —                   | Follows local semantics                                    |

**Trigger points:** cold-start (when `anyKindNeedsInvalidation()` returns true)
and an explicit `swamp doctor extensions`. It does not run on every command,
where reconcile would dominate hot-path performance.

A reconcile that fails at startup is logged ("Extension catalog repair failed")
and the command continues on the loaders' own indexing, so
`swamp doctor extensions` and `swamp extension rm`, which repair the state, stay
reachable. The populated markers are not set, so the next command retries.

Serve reload runs a scoped form, `reconcileUncataloguedPulled()`, for pulled
lockfile entries that have no catalog rows, such as files a managed-config sync
copied into a running serve. It creates aggregates only for those extensions,
saving each separately so one failure (for example a `DuplicateTypeError`)
rolls back only that extension. It skips local and source-mounted sources,
orphan tombstoning, the populated markers and the >50% guardrail. The
guardrail stops reconcile from mass transitioning existing rows, and the
scoped form never reconciles an existing aggregate. Each save still runs
saveAll's origin-conflict resolution across the repo, as every pull does, so it
can clear the type on a pulled row that a local or source-mounted row also
claims. Its saves skip saveAll's prune of rows whose source is outside the repo
root (`pruneUnreachable: false`), which would otherwise delete the rows of
sources mounted from outside the repo. An entry with no entry-point sources on
disk is reported as skipped, and nothing is saved for it.

**dryRun mode:** `execute({ dryRun: true })` collects transitions without
calling `repository.saveAll()`. It returns `ReconcileTransition` records
(`{ source, fromState, toState, reason }`) that `swamp doctor extensions`
renders directly.

**Transition-count guardrail:** if a run would transition more than 50% of
existing rows (minimum 10 rows), it aborts and returns the transitions unapplied.
This catches mass-tombstone bugs.

**enforceI2 transform.** The Extension aggregate enforces I2 by picking a
deterministic winner and tombstoning the loser instead of throwing. The Source
with the lexicographically smaller `canonicalPath` wins; the loser is tombstoned
with reason `"renamed"`. Cross-aggregate uniqueness (I-Repo-1) still throws
`DuplicateTypeError` at the repository layer, after a reconcile save has settled
pulled-vs-pulled conflicts. Both checks skip `extension`-kind
Sources: an extension's type is the base type it adds methods to, and one
package may ship several extension files for the same base type.

**Unreadable dependencies.** `computeSourceFingerprint`
(`src/domain/extensions/bundle_freshness.ts`) substitutes the internal
`UNREADABLE_PLACEHOLDER` constant for any dependency it cannot hash, so broken
transitive deps give a stable fingerprint. The failure then surfaces at
`bundleAndIndexOne` as `BundleBuildFailed`. Zod schema validation failures (the
bundle built but its export was rejected) surface as `ValidationFailed`, via a
`ValidationError` subclass carrying the bundle path and fingerprint (see
`validation_error.ts`).

**Forward-only revert posture.** To revert, delete `_extension_catalog.db`; the
next cold-start rebuilds it from disk.

## `swamp doctor extensions` — aggregate-state rendering and repair

`swamp doctor extensions` (`src/cli/commands/doctor_extensions.ts`) does two
things:

1. **Aggregate-state rendering**: per-extension RowState distribution, orphan
   detection and summary rollups, in both `log` and `json` modes. It always runs
   after the existing invalidation-guard checks. `--verbose` adds per-source
   detail.

2. **Repair**: `--repair` prunes Tombstoned/OrphanedBundleOnly catalog rows and
   deletes unreferenced `.js` files in `<kind>-bundles/`. `--dry-run` previews
   the repair; `-y`/`--yes` (alias `-f`/`--force`) skips the confirmation
   prompt. There is no `--apply` flag.

**Bundle naming convention:** a rebundle overwrites the file (not
content-addressed), so orphans grow by one per deleted source. The `bundle_path`
column is the source of truth for which files are referenced.

**Event model:** `DoctorExtensionsReport` gains `aggregateState`,
`repairReport` and `recentTransitions` fields, with no new event kinds, so
existing `--json` consumers keep working.

**`recentTransitions`**: an array, always present (empty when nothing changed),
filled from `ReconcileResult.transitions[]`. Each entry has `sourcePath` (from
`SourceLocation.canonicalPath`, matching `sourceDetails[].sourcePath`),
`fromState`, `toState` and `reason`. There is no timestamp, because every
`doctor extensions` run triggers reconcile and all transitions come from the
current process. JSON mode always includes the array; log mode shows it only
with `--verbose`. It comes through the
`DoctorExtensionsDeps.getRecentTransitions` callback, so the generator stays
free of infrastructure.

**Repair safety:** repair never touches Indexed and Bundled rows.

**Member collisions and warning categories:** after the registries load, doctor
loads every model type that an extension row targets, so extensions attach and
collisions resolve. The report's `memberCollisions` array lists each collision
with its winner (null when a base-model member wins) and its losers. Each
warning keeps the category it was raised with (`TypeExtractionFailed`,
`MemberCollision`, or `ExtensionAttachFailed`). Both are advisory and never
change `overallStatus`. The CLI and the serve admin handler build these through
the same helpers, `toDoctorWarnings` and `extensionMemberDoctorDeps`.

## Lazy Per-Bundle Loading

Each extension bundle is imported on demand, not all at once, so CLI response
time stays constant however many extensions are installed.

### Architecture

**Extension Catalog**: a SQLite database at `.swamp/_extension_catalog.db`
indexes every known bundle type. Each row stores the normalized type
(`type_normalized`), bundle path, source path, source mtime, source fingerprint
(sha-256 content hash), version, the RowState discriminant (`state`) and, for
extensions, the base type it targets (`extends_type`)
(`src/infrastructure/persistence/extension_catalog_store.ts`). The content
fingerprint decides freshness; `source_mtime` is kept only for observability.
The catalog sits at the `.swamp` root because all registry types (models,
vaults, datastores, reports) share it. It is independent of the data catalog
(`_catalog.db`) used for data queries.

A `kind` column (`model`, `extension`, `vault`, `datastore`, `report`) lets one
catalog serve every registry type. The model, vault, datastore and report
registries all register lazy entries from it (`registerLazy` in each registry).
The per-kind `populated:<kind>` marker in `bundle_meta` records whether a kind
has been fully indexed.

**Loading Flow**:

1. On the first `ensureLoaded()` call, the model registry's loader runs
   `buildIndex()`, which:
   - Checks the catalog's `populated` flag.
   - If populated: scans source directories and computes a sha-256 content
     fingerprint over each entry point plus its transitive local `.ts`
     dependencies. It compares that with the stored fingerprint, rebundles only
     changed files, then registers lazy entries for every type from the catalog
     without importing bundles.

     Fingerprints replaced mtime-based freshness in issue #125, because mtime
     was unreliable with atomic-rename saves, mtime-preserving sync tools and
     sub-millisecond edits.

     The fingerprint is **total**. If a transitive dep is unreadable (broken
     symlink, deleted file, FilesystemLoop), its hash entry becomes a stable
     sentinel instead of throwing. A stable broken state then gives a stable
     fingerprint, and the entry is not marked permanently stale (#208). Fixing
     the dep turns the sentinel back into a real hash and triggers a rebundle.
     All four kinds (models, vaults, datastores, reports) share this, since
     they share the freshness service.

     Likewise, a source can bundle and import cleanly but fail schema
     validation (e.g. a required field was removed). Its catalog row is then
     upserted with the new fingerprint and `state = ValidationFailed`. (The
     former `validation_failed` column was folded into `state`.) Fingerprint
     comparison still works: `findStaleFiles` sees the row, so a stable broken
     source stays not-stale. Registration skips non-`Indexed` rows, so the
     extension stays out of the registry until the source is fixed. Editing the
     source gives a new fingerprint, marks the file stale, triggers a rebundle
     and moves the row back to `Indexed`. This covers only the steady-state
     `rebundleAndUpdateCatalog` hot path. The cold-start parses (initial
     `loadModels` Pass 1, the by-name `loadSingleType`, and the
     extension-attach predicate) keep their existing failure behavior, as they
     are outside the read-only steady-state loop.
   - **Fingerprint preservation on build failure (issue #265).** When
     `bundleWithCache` returns the cached `.js` instead of a fresh bundle
     (`fromCache: true`), the caller `rebundleAndUpdateCatalog` keeps the
     catalog's stored `source_fingerprint` rather than writing the new one.
     The file stays "stale", so `findStaleFiles` retries on the next warm
     start. Writing the new fingerprint next to the old bundle would hide the
     staleness for good: fingerprints would match and nothing would retry.
     `BundleResult` (`bundle_freshness.ts`) records why the bundle came from
     cache in `cacheReason`, and each case logs at most one warning:
     - `trusted-pulled`: a pulled extension's existing bundle is reused on
       purpose, with no rebundle attempt (the bundle exists and either the
       caller passed `trustPulledCache` or `isExpectedBundleFailure` is true).
       Nothing failed, so both `load()` and reconcile log at debug only.
     - `rebundle-failed` with `expectedFailure: false`: `deno bundle` threw
       although a project `deno.json`/`deno.jsonc` exists. `bundleWithCache`
       emits the one warning
       `Rebundle failed for <file>, using cached bundle: <error>`, and the
       reconcile line drops to debug.
     - `rebundle-failed` with `expectedFailure: true`: no project deno config
       exists between the source file and the repo root
       (`isExpectedBundleFailure`), so failure is expected, usually from bare
       specifiers. `bundleWithCache` logs at debug and reconcile emits the one
       warning `Bundle could not be regenerated for <file> — source fingerprint
       preserved, will retry on next command`.

     The fingerprint is kept the same way in all three cases. The reconcile log
     fires only when stored and new fingerprints differ, never on a normal
     cache hit with unchanged source. `findStaleFiles` treats a changed
     fingerprint as stale, and also retries `BundleBuildFailed` rows whose
     fingerprint matches, as described under the warm-start path above
     (`src/domain/extensions/bundle_freshness.ts`). Warm start and reconcile
     work on independent axes.

   - If not populated (first run or DB deleted): bundles every source file
     without importing it into V8 (`load()` with `indexOnly: true`), fills the
     catalog from source extraction and registers lazy entries. This avoids OOM
     in repos with thousands of model definitions: bundles stay on disk until
     `ensureTypeLoaded()` imports them. Schema validation errors wait until the
     type is first used, as in warm start.

2. `types()` returns both fully loaded and lazy type names, so commands like
   `model type search` import no bundles.

3. When a specific type is needed (e.g. `model get`, `model create`),
   `ensureTypeLoaded(type)` looks up its bundle path in the catalog and imports
   only that bundle, plus any extension bundles targeting the base type.

4. Concurrent callers for the same type share one load promise (per-type
   memoization). `ensureTypeLoaded` also awaits a pending load promise when the
   type is already in the registry. `loadSingleType` registers the base type via
   `promoteFromLazy` before attaching extensions, so a caller arriving between
   those steps must wait for the extensions to be merged (swamp-club#521).

### Self-Healing

Deleting `_extension_catalog.db` triggers a cold-start rebuild on next access:
source files are bundled without importing into V8 and the catalog is refilled
from source extraction. Types are then lazy entries imported on demand. The
`populated` flag follows the data catalog's backfill pattern.

## Reporting Issues Against Extensions

`--extension <name>` (alias `-x`) on the `swamp issue bug|feature|security`
commands files a report against a specific extension. The CLI routes it by the
extension's collective and declared `repository`:

1. **`@swamp/*` extensions** go to the existing swamp-club Lab, the same
   endpoint `swamp issue bug` uses. The extension name, installed version and
   the reporter's environment are appended to the body under an
   `## Environment` section. The title is unchanged.

2. **Third-party extensions with `repository` set** go to that upstream
   repository. If the `gh` CLI is installed and authenticated (`GH_TOKEN` or
   `gh auth login`), the report is created with `gh issue create`. Otherwise the
   CLI opens the provider's new-issue URL in the browser with title and body
   filled in (supported for GitHub and GitLab). For other hosts it opens the
   repo root and prints the prepared body for manual pasting.

3. **Third-party extensions without `repository`** are refused cleanly. The
   guidance points reporters to the extension's swamp-club page, which has
   publisher contact info, and tells publishers to add a `repository:` field to
   their manifest. The exit code stays 0; the refusal is informational.

### Security Routing

For `swamp issue security --extension <name>` against a third-party GitHub
repository, the CLI first checks whether GitHub's Private Vulnerability
Reporting (PVR) is enabled, via
`gh api repos/<owner>/<repo>/private-vulnerability-reporting`:

- **PVR enabled**: open the GitHub advisory form
  (`<repo>/security/advisories/new`). It is structured and can't be prefilled
  from the URL, so the user fills it in.
- **PVR disabled**: **refuse**. This is a security guardrail that must not be
  removed. The CLI never falls back to a public issue for a security report,
  since that would silently publish the vulnerability. The refusal tells the
  reporter to contact the publisher privately and the publisher to enable PVR at
  `<repo>/settings/security_analysis`.
- **PVR check failed or gh unavailable**: open the advisory URL and show a
  fallback issue URL in the output. The user decides after seeing GitHub's
  response.

GitHub and GitLab differ on purpose. GitLab opens the normal issue form with a
"toggle confidential" warning, because confidential issues exist on every GitLab
repo and so always give the user a safe path. GitHub's PVR is opt-in per repo,
so with PVR off the CLI refuses rather than trust the reporter not to file
publicly.

### Publish-Time Nudge

When `swamp extension push` runs on a manifest without a `repository` field, the
CLI warns that users will not be able to file issues via `--extension`. The
warning never blocks the push; some publishers may leave out `repository`
on purpose.
