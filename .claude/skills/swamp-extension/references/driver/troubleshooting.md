# Troubleshooting — Extension Drivers

## Driver type not found

**Symptom:** `Driver type "..." not found` when running a model or workflow.

**Causes:**

1. File not in `extensions/drivers/` — check directory location
2. Missing or wrong export: must be `export const driver = { ... }`
3. Type pattern invalid — must match `@collective/name` or `collective/name`
   (lowercase, alphanumeric, hyphens, underscores only)
4. Reserved collective — cannot use `swamp` or `si`
5. Duplicate type — another extension already registered this type

**Debug:** Check swamp's startup logs for loader errors. Files without
`export const driver` are silently skipped (treated as utility files).

## Pending vs persisted outputs

**Symptom:** Data not appearing in `swamp model get` after driver execution.

**Understanding output types:**

- `"pending"` — driver returns raw content; swamp persists it to the datastore.
  This is the standard type for out-of-process drivers.
- `"persisted"` — driver already wrote data; handle references existing data.
  Only used by in-process drivers (like `raw`).

**Common mistake:** Returning `"persisted"` from an out-of-process driver
without actually writing data. Always use `"pending"` for custom drivers unless
you're writing directly to the datastore.

## Resolution priority confusion

**Symptom:** Wrong driver being used for a step.

**Priority:** `step > job > workflow > definition > "raw"`

The first non-undefined `driver` value wins. There is **no config merging**
across levels — the winning level's `driverConfig` is used as-is.

**Debug:** Check all levels (step, job, workflow, definition) for `driver:`
fields. The most specific (step-level) takes precedence.

## Stale bundles

**Symptom:** Changes to your driver code aren't taking effect.

**Cause:** Bundles are cached in `.swamp/driver-bundles/` with
content-fingerprint (sha-256) invalidation, so edits should be detected
regardless of mtime. If a bundle still looks stale, the cache file itself may be
corrupt.

**Note on first upgrade:** The first `swamp` command after upgrading from a
pre-fingerprint binary rebundles every driver extension once — legacy catalog
rows carry an empty fingerprint that forces one rebundle, then subsequent runs
settle back to the normal cache-hit path.

**Fix:** Delete the cached bundle:

```bash
rm -rf .swamp/driver-bundles/
```

Then run any swamp command to trigger re-bundling.

## Import errors

**Symptom:** `Error: Cannot resolve module "npm:some-package"` or similar.

**Causes:**

1. Dynamic `import()` — not supported, use static imports only
2. Unpinned npm version — always pin (e.g., `npm:pkg@1.2.3`)
3. Package not compatible with Deno — check Deno compatibility

**Fix:** Ensure all imports are static top-level `import` statements with pinned
versions.

## Timeout and process management

**Symptom:** Driver hangs or doesn't respect timeouts.

**Best practices:**

- Always implement timeout handling in your `execute()` method
- Use `AbortSignal` or `setTimeout` with process cleanup
- Send SIGTERM first, then SIGKILL after a grace period
- Return `status: "error"` with a descriptive message on timeout

See the Docker driver (`docker_execution_driver.ts`) for a reference
implementation of timeout handling with SIGTERM/SIGKILL.

## Initialize/shutdown lifecycle

**Symptom:** Resources not cleaned up after workflow execution.

**Notes:**

- `initialize()` is called before the first `execute()` invocation
- `shutdown()` is called when the driver is no longer needed
- Both are optional — only implement if your driver needs setup/teardown
- `shutdown()` should be idempotent (safe to call multiple times)
