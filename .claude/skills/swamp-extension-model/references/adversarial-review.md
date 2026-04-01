# Extension Adversarial Review

After writing or significantly modifying extension code, review against each
applicable dimension below before running tests or pushing. Present findings to
the user before proceeding.

## When to Run

- After writing new extension code, before unit tests
- After revising code in response to smoke test failures (review only changed
  dimensions)
- Before publishing with `swamp extension push`

## Universal Dimensions

These apply to **all** extension types (models, drivers, vaults, datastores).

### 1. Credentials & Secrets

- **API tokens, passwords, service-specific secrets**: Store in vault and mark
  schema fields with `.meta({ sensitive: true })`. Use `sensitiveOutput: true`
  on output specs that are entirely secret.
- **Cloud provider credentials (AWS, GCP, Azure)**: Prefer environment-based
  auth (IAM roles, instance profiles, env var credential chains) over vault
  storage. Don't store what you don't need to.
- **Best option**: Defer to the environment when possible. Only vault what can't
  be sourced from env vars or provider-native auth mechanisms.
- Config schemas should accept vault references for credential fields where
  vaulting is appropriate.
- Scope credentials narrowly — use read-only tokens when write access isn't
  needed.

### 2. Logging Quality

- Every method should log at `info` level on entry (what it's about to do) and
  completion (what it did).
- Use structured placeholders:
  `context.logger.info("Created {resource}", { resource: name })` — never string
  interpolation.
- Use appropriate levels:
  - `debug` — internal state, intermediate values
  - `info` — user-visible progress, state transitions
  - `warning` — recoverable issues, degraded behavior
  - `error` — failures that stop the operation
- **Never log sensitive data** — API keys, tokens, passwords, secret values must
  not appear in log messages or structured properties.

### 3. Error Handling

- **Throw before writing data**: If validation or an API call fails, throw
  before calling `writeResource` or `createFileWriter`. The workflow engine
  catches exceptions and marks the method as failed — partial writes create
  inconsistent state.
- Error messages must be descriptive and actionable: include the operation that
  failed, the resource involved, and the error detail.
- HTTP errors should include the status code and response body (or a summary).
- Distinguish transient errors (429 Too Many Requests, 503 Service Unavailable,
  network timeouts) from permanent errors (403 Forbidden, 404 Not Found) when
  the distinction affects recovery.
- Scope try/catch blocks narrowly — don't catch broadly and swallow errors.

### 4. Testing Completeness

- Unit tests use the appropriate test context (`createModelTestContext`,
  `createDriverTestContext`, `assertVaultExportConformance`,
  `assertDatastoreExportConformance`).
- Cover both success and failure paths — test what happens when the API returns
  an error, when a resource already exists, when input is invalid.
- Use the injectable client pattern or mock primitives (`withMockedFetch`,
  `withMockedCommand`) for code that calls external APIs.
- Use `storedResources` to seed existing state for update/delete/sync method
  tests.

### 5. Idempotency & Resilience

- **Create** methods should handle "already exists" gracefully — return the
  existing resource rather than throwing.
- **Delete** methods should handle "already gone" gracefully — succeed rather
  than throw on 404.
- Consider partial failure: if the method is interrupted mid-execution, what
  state does it leave behind? Are there orphaned cloud resources or partial
  writes?

### 6. API Contracts

- Validate or check external API responses before accessing fields — don't
  assume the shape is correct.
- Handle pagination for list endpoints that return paginated results.
- Respect rate limits — honor `Retry-After` headers and use backoff when
  appropriate.
- Verify that URLs, HTTP methods, and request body schemas match the provider's
  current documentation.

### 7. Resource Management

- Clean up network connections, file handles, and temporary files on all code
  paths, including error paths.
- Methods that create cloud resources should track resource IDs so they can be
  referenced for later cleanup or deletion.

## Type-Specific Dimensions

### Models

- **Schema strictness**: Zod schemas should use `z.object({...})` without
  `.passthrough()` — passthrough prevents CEL expression validation.
- **Lifetime & GC**: Every resource/file spec should have `lifetime` and
  `garbageCollection` configured appropriately.
- **CRUD completeness**: CRUD lifecycle models should have create, update,
  delete, and sync methods.
- **Pre-flight checks**: Mutating methods should have pre-flight checks with
  labels (e.g., `"policy"`, `"live"`) for selective skipping.
- **Instance names**: Instance names must be unique across specs within a method
  execution.
- **Data access**: Use `readResource` (not direct `dataRepository` access) for
  reading back stored state in update/delete/sync methods.
- **Version upgrades**: When bumping the model `version`, always add an
  `upgrades` entry with migration logic.

### Drivers

- Return the correct output `kind` — `"pending"` for data that swamp should
  persist, `"persisted"` for data already written by the driver.
- Record `durationMs` accurately in execution results.
- Forward logs to the host via `callbacks.onLog()`.
- Handle the `initialize`/`shutdown` lifecycle correctly.
- On error, set `status: "error"` with a useful error message.

### Vaults

- `get` must throw on missing keys — never return an empty string.
- `put` must be idempotent — overwrite existing keys without error.
- `list` must return key names only, never secret values.
- `getName` must return the vault instance name passed to the constructor.

### Datastores

- `createLock` must return a working `DistributedLock` with all required methods
  (`acquire`, `release`, `withLock`, `heartbeat`).
- `withLock` must release the lock on both success and error paths.
- `createVerifier` must return accurate health information with latency.
- `resolveDatastorePath` must be deterministic for the same inputs.
- Remote datastores must implement `resolveCachePath`.

## What This Review Does NOT Check

These are already covered by other gates:

- **Formatting** — `deno fmt` (enforced by extension quality checker)
- **Linting** — `deno lint` (enforced by extension quality checker)
- **eval/Function usage** — extension safety analyzer
- **File restrictions & sizes** — extension safety analyzer
- **Collective consistency** — extension collective validator
- **General logic & security** — CI adversarial review
