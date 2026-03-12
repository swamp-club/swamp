# Extensions

An extension in swamp is a distributable package of models and workflows that
can be shared through a registry. Extensions allow the community to share
reusable automation models and workflows that others can pull into their repositories.

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

## Manifest

Every extension is defined by a `manifest.yaml` file. The manifest declares
what the extension contains and how it should be packaged.

### Required Fields

- `manifestVersion`: Must be `1` (the only supported version).
- `name`: Scoped name (`@collective/name`).
- `version`: CalVer version string.
- At least one of `models` or `workflows` must be present.

### Optional Fields

- `description`: Human-readable description of the extension.
- `models`: Array of relative paths to TypeScript model files (e.g.,
  `["aws/ec2/instance.ts"]`).
- `workflows`: Array of relative paths to YAML workflow files.
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
    ├── models/           # Source TypeScript files
    │   └── ssh/
    │       ├── connection.ts
    │       └── helpers.ts
    ├── bundles/           # Compiled JavaScript bundles
    │   └── ssh/
    │       ├── connection.js
    │       └── helpers.js
    ├── workflows/         # YAML workflow files
    │   └── ssh-check.yaml
    └── files/             # Additional files
        └── ssh/
            └── known_hosts_template.txt
```

### Models

Source TypeScript files are included preserving their relative directory
structure from the models directory. Local imports are resolved recursively —
if `connection.ts` imports `./helpers.ts`, both files are included.

### Bundles

Each model entry point is compiled using `deno bundle` with only `zod`
externalized (`--external npm:zod@4 --external npm:zod`). All other npm
packages are inlined into the bundle, which ensures they work in the compiled
binary where only swamp's own embedded dependency graph is available. Zod is
externalized so extensions share the same zod instance as swamp (required for
schema `instanceof` checks). Dynamic `import()` calls are not supported — all
imports must be static top-level imports. Bundles are JavaScript files stored
alongside their source counterparts under `bundles/`.

### Workflows

Workflow YAML files are included with unique archive names derived from their
directory path to avoid collisions.

### Additional Files

Files listed in `additionalFiles` are included under the `files/` directory
preserving their relative paths.

## Import Resolution

When packaging an extension, the CLI resolves all local TypeScript imports
starting from each model entry point. The resolver follows relative
`import`/`export` statements (e.g., `./helpers.ts`, `../shared.ts`) and
includes all transitively imported files. Only files within the models directory
boundary are included. Non-local imports (npm packages) are skipped as they are
resolved at runtime.

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

| Archive directory | Destination                                                            |
| ----------------- | ---------------------------------------------------------------------- |
| `models/`         | `{modelsDir}` (from `.swamp.yaml`, default `extensions/models/`)       |
| `workflows/`      | `{workflowsDir}` (from `.swamp.yaml`, default `extensions/workflows/`) |
| `bundles/`        | Datastore `bundles/` (default `.swamp/bundles/`)                       |
| `files/`          | `{modelsDir}`                                                          |

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
