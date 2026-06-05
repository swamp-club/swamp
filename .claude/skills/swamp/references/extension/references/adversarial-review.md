# Extension Adversarial Review

After writing or **significantly modifying** extension code (anything beyond a
typo, comment tweak, or trivial rename), review against each applicable
dimension below **before running smoke tests or unit tests**. Present findings
to the user before proceeding.

This is step 4 of the Development Workflow in
[../guide.md](../guide.md#shared-development-workflow) and gates steps 5 (smoke
test) and 6 (unit tests).

## When to Run

- After writing new extension code, **before** smoke tests or unit tests
  (workflow step 4 — see the
  [Adversarial Review Gate](../guide.md#adversarial-review-gate))
- After revising code in response to smoke test failures (review only changed
  dimensions)
- Before publishing with `swamp extension push`

## Recording the Review (checked at push)

`swamp extension push` checks for this review. A missing, stale, or incomplete
report surfaces as a warning the user must confirm before the push proceeds (it
is not a hard block — a benign version bump should not brick a push). The report
is bound to a content hash: any source change (or version bump) moves the report
path, so a prior review no longer matches and a fresh one is requested.

Workflow:

1. Review the code against every applicable dimension below.
2. Run `swamp extension push manifest.yaml --dry-run`. When no report exists,
   the push prints the exact report path (a content-hash-bound JSON file under
   the system temp directory) and a fill-in skeleton listing every applicable
   dimension with `"verdict": "pending"`.
3. Write the skeleton to the printed path, setting each dimension's `verdict`:
   - `pass` — the dimension is satisfied.
   - `issue` — a problem was found; add a `note`. (Surfaces as a push warning,
     does not block.)
   - `na` — the dimension does not apply (e.g. `api-contracts` for an extension
     making no HTTP calls).
   - Leave none as `pending` — a `pending` or missing verdict surfaces as a push
     warning to confirm.
   - Set `reviewedAt` to the current ISO-8601 timestamp.
4. Present the findings to the user, then run `swamp extension push`.

Report schema (the skeleton already has the right shape):

```json
{
  "extension": "@collective/name",
  "version": "2026.05.31.1",
  "reviewedAt": "2026-05-31T21:00:00Z",
  "dimensions": [
    { "id": "credentials-secrets", "verdict": "pass" },
    {
      "id": "error-handling",
      "verdict": "issue",
      "note": "delete swallows 404"
    }
  ]
}
```

The applicable dimension `id`s are the universal set plus the type-specific set
for the content kinds present (the skeleton lists exactly these). The push gate
checks that the report matches the extension name/version, covers every
applicable dimension, and has no `pending` verdicts.

## Mandatory Mechanical Verification

Execute these checks **before** the dimensional review. They catch structural
mismatches between schemas and writes that judgment-based review consistently
misses. Each check is binary — fix any failure before proceeding.

### 1. Schema-Write Conformance

For every `writeResource` call in every method:

1. Identify which spec the call targets (the spec name argument).
2. Read that spec's Zod schema — list every field.
3. Read the data object passed to `writeResource` — list every field.
4. Verify:
   - Every schema field appears in the data object.
   - No data field is absent from the schema.
   - No field is hardcoded to a placeholder (`[]`, `""`, `0`, `false`, `null`,
     `"TODO"`) when the schema implies real data.
   - The spec name matches the intent — a method writing seat data should target
     the seats spec, not a differently-shaped spec.

### 2. Truncation Honesty

For every method that paginates or caps results:

1. Find the pagination loop or result cap.
2. Verify the output spec schema includes a `truncated` (or equivalent) boolean
   field.
3. Verify the `writeResource` call sets that field — `true` when results were
   capped, `false` otherwise.

### 3. Instance Name Consistency

For every spec that multiple methods can write to:

1. List all methods that call `writeResource` for that spec.
2. Verify each method writes data conforming to the same schema shape.
3. Verify instance names don't collide across methods writing incompatible data.

This reinforces the "Instance names" dimension under Models — the mechanical
check here is to explicitly enumerate and compare, not rely on a judgment call.

### 4. Schema Field Coverage

For every spec in the extension:

1. Count the schema fields.
2. Count the fields actually written across all methods that target that spec.
3. Confirm 1:1 coverage — no schema field is never written, no written field is
   absent from the schema.
4. For optional or conditional fields, verify the code path that populates them
   exists (not just that the field is declared).

### Reporting Mechanical Failures

Any mechanical check failure is a blocker — fix the code before starting the
dimensional review. In the findings report, prefix mechanical failures with
`MECHANICAL:` so they are visually distinct:

```markdown
- Schema-Write Conformance: MECHANICAL: `sync` writes `byUser: []` but
  ByUserSchema expects `{ login, role, lastActive }` — placeholder never
  populated.
```

## Output Format

Produce a structured findings report with one line per applicable dimension.
Each line is either `PASS` or `ISSUE FOUND` with detail. Use the dimensions that
apply to your extension type (universal + the relevant type-specific section).
Skip dimensions that do not apply (e.g. omit "API Contracts" for an extension
that makes no external HTTP calls — note the omission explicitly).

```markdown
## Adversarial Review — <extension name>

**Universal**

- Credentials & Secrets: PASS
- Logging Quality: PASS
- Error Handling: ISSUE FOUND — `delete` swallows 404 with a broad `try/catch`;
  should narrow to the specific status code.
- Testing Completeness: PASS
- Idempotency & Resilience: PASS
- API Contracts: PASS
- Resource Management: PASS

**Models** (type-specific)

- Schema strictness: PASS
- Lifetime & GC: PASS
- CRUD completeness: ISSUE FOUND — no `sync` method; drift detection is blocked.
- Pre-flight checks: PASS
- Instance names: PASS
- Data access: PASS
- Version upgrades: not applicable (initial version)
```

Each `ISSUE FOUND` line must be specific enough that the user can act on it
without re-reading the code. After listing findings, decide whether each issue
is a blocker (fix before testing) or a follow-up (acknowledge with the user and
continue). Do not proceed to step 5 until the user has acknowledged the report.

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

### 8. Published-Surface Hygiene

- **README examples, `additionalFiles`, and test fixtures** must use placeholder
  values, not real infrastructure identifiers. Check for:
  - Real IP addresses — use RFC 5737 documentation ranges (`192.0.2.x`,
    `198.51.100.x`, `203.0.113.x`) instead
  - Internal hostnames, bastion/jump addresses, `.internal`/`.local`/`.corp`
    domains — use `example.com`, `host.example.net` instead
  - Internal subnet topology (real CIDR blocks, VLAN IDs, real cloud VPC/subnet
    identifiers)
  - Cloud account IDs, project numbers, or tenant identifiers
- The push-time safety analyzer automatically warns on IPv4 address literals in
  `.md` and `.txt` files. This dimension covers what the automated check cannot
  reliably detect: hostnames, topology descriptions, and identifiers in code
  blocks and test fixtures.
- Common safe replacements: RFC 5737 IPs, `example.com`/`example.net`/
  `example.org` (RFC 2606), `ACME-ACCOUNT-ID`, `vpc-example`, `subnet-example`.

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
- Remote datastores should define `resolveCachePath` (return `undefined` for
  core's repoId-keyed default). Optional in the type, but every `@swamp/*`
  datastore follows this convention so the intent is explicit.

## What This Review Does NOT Check

These are already covered by other gates:

- **Formatting** — `deno fmt` (enforced by extension quality checker)
- **Linting** — `deno lint` (enforced by extension quality checker)
- **eval/Function usage** — extension safety analyzer
- **File restrictions & sizes** — extension safety analyzer
- **Collective consistency** — extension collective validator
- **General logic & security** — CI adversarial review
