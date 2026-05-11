# Troubleshooting — Extension Vaults

## Vault type not appearing

**Symptom:** `swamp vault status` doesn't show your custom type.

**Causes:**

1. File not in `extensions/vaults/` — check directory location
2. Missing or wrong export: must be `export const vault = { ... }`
3. Type pattern invalid — must match `@collective/name` or `collective/name`
   (lowercase, alphanumeric, hyphens, underscores only)
4. Reserved collective — cannot use `swamp` or `si`
5. Duplicate type — another extension already registered this type

**Debug:** Check swamp's startup logs for loader errors. Files without
`export const vault` are silently skipped (they're treated as utility files).

## Config validation errors

**Symptom:** `Invalid config for vault type "...": <zod error>`

**Causes:**

1. `.swamp.yaml` `config:` section doesn't match your `configSchema`
2. Missing required fields in the config
3. Config values have wrong types (e.g., number instead of string)

**Fix:** Check your Zod schema against the config you're providing. Run
`swamp vault status --json` to see the full error message.

## Stale bundles

**Symptom:** Changes to your vault code aren't taking effect.

**Cause:** Bundles are cached in `.swamp/vault-bundles/` with
content-fingerprint (sha-256) invalidation, so edits should be detected
regardless of mtime. If a bundle still looks stale, the cache file itself may be
corrupt.

**Note on first upgrade:** The first `swamp` command after upgrading from a
pre-fingerprint binary rebundles every vault extension once — legacy catalog
rows carry an empty fingerprint that forces one rebundle, then subsequent runs
settle back to the normal cache-hit path.

**Fix:** Delete the cached bundle:

```bash
rm -rf .swamp/vault-bundles/
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

## Secret not found errors

**Symptom:** `Error: Secret 'key' not found` when running `swamp vault get`.

**Causes:**

1. Secret doesn't exist in the backend — check via backend's native UI/CLI
2. Wrong vault configured — verify `.swamp.yaml` vault type and config
3. Authentication issue — check credentials/tokens in config
4. Namespace mismatch — verify the secret is in the correct namespace/path

**Debug:** Test your vault backend directly (e.g., `curl` the API) to confirm
the secret exists and is accessible with the configured credentials.

## Authentication failures

**Symptom:** `Error: Failed to get secret: 401 Unauthorized` or similar.

**Causes:**

1. Expired token — refresh or rotate credentials
2. Wrong token in config — verify the token value
3. Insufficient permissions — check the token's access policy

**Fix:** Verify credentials work outside of swamp first. Update `.swamp.yaml`
config with valid credentials.

## Network connectivity issues

**Symptom:** `Error: Failed to fetch` or timeout errors.

**Causes:**

1. Vault backend is unreachable — check network/firewall
2. Wrong endpoint URL — verify in `.swamp.yaml`
3. TLS/certificate issues — check certificate validity

**Fix:** Test connectivity to the endpoint directly:

```bash
curl -v https://your-vault-endpoint/health
```
