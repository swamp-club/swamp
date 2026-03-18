# Troubleshooting — Extension Datastores

## Datastore type not appearing

**Symptom:** `swamp datastore status` doesn't show your custom type.

**Causes:**

1. File not in `extensions/datastores/` — check directory location
2. Missing or wrong export: must be `export const datastore = { ... }`
3. Type pattern invalid — must match `@collective/name` or `collective/name`
   (lowercase, alphanumeric, hyphens, underscores only)
4. Reserved collective — cannot use `swamp` or `si`
5. Duplicate type — another extension already registered this type

**Debug:** Check swamp's startup logs for loader errors. Files without
`export const datastore` are silently skipped (they're treated as utility
files).

## Config validation errors

**Symptom:** `Invalid config for datastore type "...": <zod error>`

**Causes:**

1. `.swamp.yaml` `config:` section doesn't match your `configSchema`
2. Environment variable JSON is malformed
3. Missing required fields in the config

**Fix:** Check your Zod schema against the config you're providing. Run
`swamp datastore status --json` to see the full error message.

## Stale bundles

**Symptom:** Changes to your datastore code aren't taking effect.

**Cause:** Bundles are cached in `.swamp/datastore-bundles/` with mtime-based
invalidation. If file timestamps are incorrect (e.g., after `git checkout`), the
cache may serve stale code.

**Fix:** Delete the cached bundle:

```bash
rm -rf .swamp/datastore-bundles/
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

## Lock implementation issues

**Symptom:** `LockTimeoutError` or concurrent write corruption.

**Common mistakes:**

1. Not implementing heartbeat — lock expires while operation runs
2. Not handling stale lock detection — process crashes leave orphaned locks
3. Missing `forceRelease` nonce check — allows force-release of wrong lock

**Requirements:**

- `acquire()` must retry until `maxWaitMs`, then throw
- `acquire()` must force-acquire stale locks (TTL expired)
- `release()` must be safe to call multiple times
- `inspect()` must return current lock info without side effects

## Health check failures

**Symptom:** `swamp datastore status` shows `healthy: false`.

**Debug:** Check the `message` field in the status output for details. Common
causes:

- Directory doesn't exist or isn't writable (local datastores)
- Network connectivity issues (remote datastores)
- Missing credentials (cloud storage backends)

**Fix:** The `createVerifier().verify()` method should return a descriptive
error message. Include relevant details in the `details` field.
