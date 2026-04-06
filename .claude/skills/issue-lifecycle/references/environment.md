# Environment Setup

Read this before starting any phase. This ensures the swamp environment is ready
for model commands.

## 1. Verify Swamp is Initialized

Check if `.swamp.yaml` exists in the current repo root:

```
test -f .swamp.yaml && echo "initialized" || echo "not initialized"
```

If not initialized, run:

```
swamp repo init
```

## 2. Verify Model Type is Available

After initialization, confirm the `@si/issue-lifecycle` model type is
discoverable:

```
swamp model create @si/issue-lifecycle test-verify \
  --global-arg issueNumber=0 --json 2>&1 | head -5
```

If this returns "Unknown model type", the extension catalog may be stale. Delete
it and retry:

```
rm .swamp/_extension_catalog.db
```

Then retry the create command. If the model still isn't found, check that
`extensions/models/issue_lifecycle.ts` exists in the repo.

After verifying, clean up:

```
swamp model delete test-verify --json
```

## 3. Capture Repo Root for Scratch Repos

Store the absolute path to the current repo root. You will need this when
running swamp commands from scratch repos during reproduction:

```
REPO_ROOT=$(pwd)
```

When running swamp commands from a scratch repo (e.g.,
`/tmp/swamp-repro-issue-<N>`), prepend `SWAMP_MODELS_DIR` so the bundler can
find dev extension model files and their `deno.json` import map:

```
SWAMP_MODELS_DIR=$REPO_ROOT/extensions/models swamp <command>
```

This is necessary because scratch repos have no `extensions/models/` directory
and no `deno.json` for import resolution. The `SWAMP_MODELS_DIR` env var tells
swamp where to find model definitions, and the bundler discovers the nearest
`deno.json` by walking up from the model file's location.
