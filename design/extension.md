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

## Manifest

Every extension is defined by a `manifest.yaml` file. The manifest declares
what the extension contains and how it should be packaged.

### Required Fields

- `manifestVersion`: Must be `1` (the only supported version).
- `name`: Scoped name (`@collective/name`).
- `version`: CalVer version string.
- At least one of `models`, `workflows`, `vaults`, `drivers`, `datastores`, or
  `reports` must be present.

### Path Safety

All file paths in the manifest must be **relative and downward-only**. Paths
containing `..` components (e.g., `../../workflows/file.yaml`) or starting with
`/` (absolute paths) are rejected during push. This prevents archive entries
that would fail the pull-side safety validator, which rejects any tar entry
containing `..` or starting with `/`.

### Optional Fields

- `description`: Human-readable description of the extension.
- `models`: Array of relative paths to TypeScript model files (e.g.,
  `["aws/ec2/instance.ts"]`).
- `workflows`: Array of relative paths to YAML workflow files.
- `vaults`: Array of relative paths to TypeScript vault files.
- `drivers`: Array of relative paths to TypeScript driver files.
- `datastores`: Array of relative paths to TypeScript datastore files.
- `reports`: Array of relative paths to TypeScript report files.
- `include`: Array of relative paths (from `modelsDir`) to TypeScript files that
  should be included in the archive alongside models but not bundled. Used for
  helper scripts that are executed via `Deno.Command` subprocess rather than
  imported directly.
- `additionalFiles`: Array of paths to non-model files to include (README,
  config, etc.).
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
structure from the models directory. Local imports are resolved recursively —
if `connection.ts` imports `./helpers.ts`, both files are included.

Files listed in the manifest's `include` field are also copied to `models/` in
the archive, preserving their relative paths from `modelsDir`. Include files are
not bundled — they are raw TypeScript files intended to be executed as
subprocesses or used as standalone utilities.

### Loader pre-check

At runtime, loaders discover `.ts` files in their respective directories and
attempt to bundle each one. Before bundling, the loader reads the source and
checks for the expected named export (`export const model`, `export const vault`,
etc.). Files that don't declare the expected export are skipped — no bundling
attempted, no error. This avoids failing on helper scripts with unbundleable
dependencies (e.g., native modules used via `Deno.Command` subprocess).

### Bundles

Each model entry point is compiled using `deno bundle` with zod externalized.
All other npm packages are inlined into the bundle, which ensures they work in
the compiled binary where only swamp's own embedded dependency graph is
available. Zod is externalized so extensions share the same zod instance as
swamp (required for schema `instanceof` checks). Dynamic `import()` calls are
not supported — all imports must be static top-level imports. Bundles are
JavaScript files stored alongside their source counterparts under `bundles/`.

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
preserving their relative paths.

## Import Resolution

When packaging an extension, the CLI resolves all local TypeScript imports
starting from each entry point (model, vault, driver, datastore, or report).
The resolver follows relative `import`/`export` statements (e.g.,
`./helpers.ts`, `../shared.ts`) and includes all transitively imported files.
Only files within the respective directory boundary are included. Non-local
imports (npm packages) are skipped as they are resolved at runtime.

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

### Hot-Loading

After installation, swamp re-runs model and vault discovery with
`skipAlreadyRegistered` to load only the newly installed types. This avoids
re-registering types that were already loaded at startup.

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

Extensions are distributed through the swamp registry at `https://swamp.club`.

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
enables clean removal and conflict detection.

### Structure

```json
{
  "@keeb/ssh": {
    "version": "2026.02.26.1",
    "pulledAt": "2026-02-27T10:30:00.000Z",
    "files": [
      "extensions/models/ssh/connection.ts",
      "extensions/models/ssh/helpers.ts",
      "extensions/workflows/ssh-check.yaml"
    ]
  }
}
```

### Concurrency Safety

All mutations to `upstream_extensions.json` use an advisory lockfile
(`upstream_extensions.json.lock`) with retry logic (10 attempts, 100ms backoff)
and atomic file writes to prevent corruption from concurrent operations.

## File Extraction

When pulled, extension files are extracted to their destinations:

| Archive directory    | Destination                                                            |
| -------------------- | ---------------------------------------------------------------------- |
| `models/`            | `{modelsDir}` (from `.swamp.yaml`, default `extensions/models/`)       |
| `bundles/`           | `.swamp/bundles/`                                                      |
| `workflows/`         | `{workflowsDir}` (from `.swamp.yaml`, default `extensions/workflows/`) |
| `vaults/`            | `{vaultsDir}` (from `.swamp.yaml`, default `extensions/vaults/`)       |
| `vault-bundles/`     | `.swamp/vault-bundles/`                                                |
| `drivers/`           | `{driversDir}` (from `.swamp.yaml`, default `extensions/drivers/`)     |
| `driver-bundles/`    | `.swamp/driver-bundles/`                                               |
| `datastores/`        | `{datastoresDir}` (from `.swamp.yaml`, default `extensions/datastores/`) |
| `datastore-bundles/` | `.swamp/datastore-bundles/`                                            |
| `reports/`           | `{reportsDir}` (from `.swamp.yaml`, default `extensions/reports/`)     |
| `report-bundles/`    | `.swamp/report-bundles/`                                               |
| `files/`             | `{modelsDir}`                                                          |

If files already exist at the destination and `--force` is not set, the user is
prompted to confirm overwriting.

macOS resource fork files (`._*`) are skipped during both push (via
`COPYFILE_DISABLE=1`) and pull.

## Removal

Installed extensions can be removed with `extension rm`. Removal deletes all
files tracked in the extension's `files` array in `upstream_extensions.json`,
prunes empty parent directories, and removes the entry from the tracking file.

If other installed extensions list the target as a dependency (detected by
scanning their `manifest.yaml` files on disk), a warning is displayed before
proceeding.

Extensions pulled before file tracking was added cannot be removed cleanly —
the user is prompted to re-pull with `--force` to populate the file list first.

## Lazy Per-Bundle Loading

Extension bundles are loaded lazily — individual bundles are imported on demand
rather than all at once. This keeps CLI response times constant regardless of
how many extensions are installed.

### Architecture

**Extension Catalog**: A SQLite database at `.swamp/_extension_catalog.db`
indexes all known bundle types. Each entry stores the type name, bundle path,
source path, source mtime, version, and (for extensions) the base type it
targets. The catalog lives at the `.swamp` root level because it is shared
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
   - If populated: scans source directories, compares mtimes against catalog
     entries, rebundles only changed files, then registers lazy entries for all
     types from the catalog (no bundle imports)
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
