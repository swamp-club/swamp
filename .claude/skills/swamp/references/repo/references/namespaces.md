# Datastore Namespaces (Giga-Swamp)

Namespaces partition a shared remote datastore so multiple repos can use the
same bucket/prefix without colliding. Each repo owns a namespace slug; all
runtime data (model data, outputs, workflow runs) is written under
`{namespace}/` instead of at the root.

## Why Namespaces Matter

Without namespaces, two repos sharing one datastore prefix both write
`.datastore-index.json` at the same path — the second writer silently clobbers
the first. **Namespacing is required before a second repo joins a shared
datastore.**

## CLI Commands

All commands support `--json` for machine-readable output.

### Assign a Namespace

```bash
swamp datastore namespace set <slug> --json
```

- Validates the slug (lowercase alphanumeric + hyphens, max 64 chars)
- Checks for conflicts — rejects if the slug is already registered by a
  different repo (via `.namespace.json` manifest)
- Registers the namespace manifest at `{slug}/.namespace.json`
- Updates `.swamp.yaml` with `datastore.namespace: <slug>`

The slug must be unique per datastore. Two repos cannot claim the same
namespace.

### Migrate Data Layout

```bash
swamp datastore namespace migrate --json           # Preview (dry run)
swamp datastore namespace migrate --confirm --json # Execute
swamp datastore namespace migrate --reverse --json # Preview reverse
swamp datastore namespace migrate --reverse --confirm --json # Execute reverse
```

Moves data between solo layout (`{prefix}/data/...`) and namespaced layout
(`{prefix}/{namespace}/data/...`).

- **Preview mode** (no `--confirm`): scans all subdirectories, reports file
  counts and sizes. No data is moved.
- **Execute mode** (`--confirm`): moves files, invalidates the catalog, and
  marks extension datastores dirty for the next sync.
- **Reverse** (`--reverse`): flattens namespaced paths back to solo layout.
  Refuses if the un-namespaced path already contains data (collision detection).

### List Namespaces

```bash
swamp datastore namespace list --json
# Alias:
swamp datastore namespaces --json
```

Lists all registered namespaces in the datastore by scanning for
`.namespace.json` manifests. Shows which namespace (if any) belongs to the
current repo.

### Remove a Namespace

```bash
swamp datastore namespace unset --json                  # Remove from config only
swamp datastore namespace unset --migrate --json        # Preview reverse migration
swamp datastore namespace unset --migrate --confirm --json  # Execute reverse + remove
```

Clears `datastore.namespace` from `.swamp.yaml`. With `--migrate`, also reverses
the data layout (same as `namespace migrate --reverse`).

## Multi-Repo Workflow

The standard flow when two repos share a remote datastore (e.g. S3 or GCS):

```bash
# Repo 1 (infra):
swamp datastore setup extension @swamp/s3-datastore \
  --namespace infra \
  --config '{"bucket":"shared-bucket","prefix":"swamp","region":"us-east-1"}'

# Repo 2 (platform):
swamp datastore setup extension @swamp/s3-datastore \
  --namespace platform \
  --config '{"bucket":"shared-bucket","prefix":"swamp","region":"us-east-1"}'
```

This assigns the namespace and configures the datastore in one step. After
setup, each repo's data lives under its own namespace prefix. Locks are
per-namespace (`{prefix}/.locks/{namespace}.lock`), so the repos don't contend.

> **Note:** `namespace set` + `namespace migrate` is only needed when converting
> an existing solo repo to a namespaced layout — not for new shared setups.

## Cross-Namespace Data Access

CEL point lookups (`data.latest`, `data.version`) are implicitly scoped to the
current namespace. To read data from another namespace, use foreign catalog
methods:

```bash
# Pull catalog metadata from foreign namespaces
swamp datastore catalog pull --namespaces infra,platform --json
```

This fetches `.catalog-export.json` from each foreign namespace and imports it
into the local catalog. After pulling, `data.query` can reference models from
those namespaces.

Foreign content (the actual data attributes) is fetched on demand when a CEL
expression accesses them — it is not persisted locally.

## Namespace Manifests

Each namespace is tracked by a `.namespace.json` file at
`{namespace}/.namespace.json` in the datastore:

```json
{
  "namespace": "infra",
  "repoId": "uuid-of-the-repo",
  "registeredAt": "2026-06-03T00:00:00.000Z"
}
```

The manifest enables:

- **Conflict detection**: `namespace set` checks if the slug is already claimed
  by a different `repoId`
- **Discovery**: `namespace list` scans for manifests to enumerate all
  namespaces

## Path Resolution

- **Solo mode** (no namespace): `{datastore}/{subdir}/...`
- **Namespaced mode**: `{datastore}/{namespace}/{subdir}/...`

The local tier (`.swamp/`) is never namespaced — only the remote/external
datastore is partitioned.
