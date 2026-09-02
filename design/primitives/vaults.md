---
audience: maintainer, operator
last-verified: 2026-08-28 @ 3d5955a9
---

# swamp vaults

A swamp vault is a secure storage system that allows workflows and models to
access sensitive data through named vault configurations. Vaults provide a clean
abstraction layer over different secret management systems, enabling secure data
retrieval and storage during workflow execution.

## Architecture

The vault system is built around a named vault architecture where:

- **Named Vaults**: Each vault instance has a user-defined name configured in
  `vaults/{vault-type}/{id}.yaml`
- **Vault Types**: The underlying storage system (`local_encryption` built in;
  `@swamp/aws-sm`, `@swamp/azure-kv`, `@swamp/1password` as extensions) is
  specified per vault
- **Clean Interface**: All vaults implement a common interface for consistent
  access patterns
- **Expression Integration**: Vaults are accessed through CEL expressions using
  `${{ vault.get(vault_name, key) }}` syntax

## Secret Storage

Vault secrets are stored in the datastore `secrets/` directory (default
`.swamp/secrets/`), organized by vault type and name:

```
vaults/
  {vault-type}/
    {id}.yaml                        # Vault configuration (top-level, tracked in git)

.swamp/secrets/                      # Datastore path (default)
  {vault-type}/
    {vault-name}/
      .key                           # Encryption key (for local_encryption with auto_generate)
      {secret-key}.enc               # Encrypted secret files
```

The secrets path is computed at runtime through the datastore path resolver. The
vault configuration stores the `base_dir` (repository root), and the full path
is derived through the datastore abstraction. See [datastores](../enablers/datastores.md) for details.

## Vault Provider Interface

All vault implementations must implement the `VaultProvider` interface:

```typescript
interface VaultProvider {
  // Retrieve a secret value by key
  get(secretKey: string): Promise<string>;

  // Store a secret value with the given key. `options.tags` carries
  // provider-native tags (populated from `swamp vault put --label k=v`).
  put(
    secretKey: string,
    secretValue: string,
    options?: VaultPutOptions,
  ): Promise<void>;

  // List all secret keys in the vault (returns key names only, not values)
  list(): Promise<string[]>;

  // Get the name/type of this vault provider
  getName(): string;
}
```

## Vault Annotation Provider Interface

Vault providers can optionally support annotations — metadata attached to
secrets (URL, notes, labels). Annotation support is opt-in: providers that
implement `VaultAnnotationProvider` alongside `VaultProvider` gain annotation
capabilities. Providers that don't implement it continue to work unchanged.

```typescript
interface VaultAnnotationProvider {
  getAnnotation(secretKey: string): Promise<VaultAnnotation | null>;
  putAnnotation(secretKey: string, annotation: VaultAnnotation): Promise<void>;
  deleteAnnotation(secretKey: string): Promise<void>;
  listAnnotations(): Promise<Map<string, VaultAnnotation>>;
}
```

Detection is via runtime type guard (`isVaultAnnotationProvider()`), not
compile-time typing. Extension vault providers opt in by having their
`createProvider` return an object that implements both interfaces.

## Vault Refresh Hook Provider Interface

Vault providers can optionally support refresh hooks — per-secret metadata that
tells swamp how to auto-refresh short-lived credentials. Refresh hook support is
opt-in: providers that implement `VaultRefreshHookProvider` alongside
`VaultProvider` gain refresh capabilities. Providers that don't implement it
continue to work unchanged.

```typescript
interface VaultRefreshHookProvider {
  getRefreshHook(secretKey: string): Promise<RefreshHook | null>;
  putRefreshHook(secretKey: string, hook: RefreshHook): Promise<void>;
  deleteRefreshHook(secretKey: string): Promise<void>;
}
```

Detection is via runtime type guard (`isVaultRefreshHookProvider()`), mirroring
the annotation pattern.

## Vault Delete Provider Interface

Vault providers can optionally support deleting secrets. Delete support is
opt-in: providers that implement `VaultDeleteProvider` alongside `VaultProvider`
gain delete capabilities. Providers that don't implement it will report
"unsupported" when a user tries `swamp vault delete`.

```typescript
interface VaultDeleteProvider {
  delete(secretKey: string): Promise<void>;
}
```

Detection is via runtime type guard (`isVaultDeleteProvider()`), mirroring the
annotation and refresh hook patterns. `VaultService.delete()` only calls
`provider.delete()` (`src/domain/vaults/vault_service.ts`); the
`local_encryption` provider additionally removes the secret's annotation and
refresh hook as a best-effort cleanup inside its own `delete()`
(`src/domain/vaults/local_encryption_vault_provider.ts`). Extension providers
must do their own cascade.

Built-in providers (`local_encryption`, `mock`) implement this interface.
Extension providers (e.g. `@swamp/1password`, `@swamp/aws-sm`) may opt in by
having their `createProvider` return an object that implements both interfaces.

### Refresh Hook Value Object

`RefreshHook` is an immutable value object:

- `command: string` — the shell command to run (e.g.
  `gcloud auth print-access-token`)
- `ttlMs: number` — how long (in milliseconds) before the value is stale
- `lastRefreshedAt: Date | null` — when the value was last refreshed (UTC)

TTL evaluation: `Date.now() - lastRefreshedAt.getTime() >= ttlMs`. Both sides
are UTC — no local timezone involvement.

### Refresh-on-Read Behavior

When `VaultService.get()` is called with refresh options configured:

1. Check if the provider supports refresh hooks
2. If a hook exists for the requested key, evaluate whether it's stale
3. If stale: run the command via `executeProcess`, trim trailing whitespace from
   stdout, write the fresh value back via `provider.put()`, update
   `lastRefreshedAt`, return the fresh value
4. If the refresh command fails, or succeeds with empty stdout: log a warning
   and return the stale value (an empty result is never written back)

This is transparent to callers — `vault.get()` in CEL expressions and workflows
auto-refreshes without any workflow-level boilerplate.

### Refresh Hook CLI

```bash
# Register a refresh hook when storing a secret
swamp vault put my-vault GCP_TOKEN \
  --refresh-from "gcloud auth print-access-token" \
  --refresh-ttl 50m

# Remove a refresh hook
swamp vault put my-vault GCP_TOKEN --clear-refresh

# View refresh hook configuration
swamp vault inspect my-vault GCP_TOKEN
```

### Refresh Hook Storage (local_encryption)

For the built-in `local_encryption` provider, refresh hooks are stored as
encrypted JSON in a `.refresh/` subdirectory alongside `.annotations/`:

```
.swamp/secrets/local_encryption/{vault-name}/
  GCP_TOKEN.enc              # encrypted secret value
  .annotations/
    GCP_TOKEN.enc            # encrypted annotation metadata
  .refresh/
    GCP_TOKEN.enc            # encrypted refresh hook config
```

### Annotation Storage (local_encryption)

For the built-in `local_encryption` provider, annotations are stored as
encrypted files under `.annotations/`:

```
.swamp/secrets/local_encryption/{vault-name}/
  my-api-key.enc          # encrypted secret value
  .annotations/
    my-api-key.enc        # encrypted annotation (same AES-GCM key)
```

Annotations live in a `.annotations/` subdirectory to avoid filename collisions
with secret keys that might end in `.meta` or similar suffixes.

### Annotation CLI

```
swamp vault annotate <vault> <key> --url <u> --notes <text> --label <k=v>
swamp vault annotate <vault> <key> --remove-label <key>
swamp vault inspect <vault> <key>
swamp vault annotate <vault> <key> --clear
```

Annotations use merge semantics: only the fields specified in flags are updated,
existing fields are preserved. `--remove-label` removes a single label by key
(repeatable). `--clear` removes all annotations and cannot be combined with
other annotation flags.

### Vault Inspect Output

`swamp vault inspect <vault> <key>` shows all available metadata for a vault
item without exposing the secret value:

- `sizeBytes` — byte length of the stored value (UTF-8 encoded)
- `sizeChars` — character count of the stored value
- `valueType` — always `"string"` (the vault provider interface stores strings)
- `annotation` — url, notes, labels, updatedAt (if the provider supports
  annotations)
- `refreshHook` — command, ttl, lastRefreshedAt (if the provider supports
  refresh hooks)

Inspect degrades gracefully: providers that don't support annotations or refresh
hooks return `null` for those fields with explicit `supportsAnnotations` /
`supportsRefreshHooks` booleans so consumers can distinguish "not supported" from
"supported but empty."

The secret value is never returned. Size is measured internally via a deps
factory function that calls `get()`, measures the byte length, and returns only
the number — the secret never enters the operation's scope.

### JSON Output

```json
{
  "vaultName": "my-vault",
  "secretKey": "API_KEY",
  "vaultType": "local_encryption",
  "sizeBytes": 42,
  "sizeChars": 42,
  "valueType": "string",
  "supportsAnnotations": true,
  "hasAnnotation": true,
  "annotation": {
    "url": "https://console.aws.amazon.com/iam",
    "notes": "Production API key",
    "labels": { "env": "prod" },
    "updatedAt": "2026-01-15T10:30:00.000Z"
  },
  "supportsRefreshHooks": false,
  "hasRefreshHook": false,
  "refreshHook": null
}
```

## Expression Syntax

Vaults are read in expressions using `vault.get()`:

```yaml
# Basic vault access
keyData: ${{ vault.get(aws, machineKeyData) }}

# Different vault for different environments
prodSecret: ${{ vault.get(prod-vault, apiKey) }}
devSecret: ${{ vault.get(dev-vault, apiKey) }}
```

The expression syntax is:

- `vault.get(vault_name, key)` - Retrieve a secret from the named vault
- `vault_name` - References a configured vault
- `key` - The secret identifier within that vault

`vault.get` is not a CEL function. It is matched by a regex and substituted
before CEL evaluation (`resolveVaultExpressions` in
`src/domain/expressions/model_resolver.ts`): each match is resolved through
`VaultService.get()` and replaced with a sentinel string (or an escaped literal
when no secret bag is present). There is no `vault.put` expression — writes go
through `swamp vault put` or sensitive-field marking (below).

Arguments can be quoted literals or bare-token CEL expressions. Bare tokens
containing `.` (e.g. `inputs.vaultName`) are CEL-evaluated against the runtime
context before the vault lookup. See
[expressions.md § Dynamic Vault Arguments](../enablers/expressions.md#dynamic-vault-arguments)
for details, security notes, and known limitations.

## CLI Surface

Vault commands live in `src/cli/commands/vault_*.ts`. Beyond `create`, `put`,
`delete`, `annotate`, `inspect`, `migrate`, `audit-trail`, and `read-secret`
(documented in their own sections), the command group provides:

- `swamp vault list-keys <vault>` — secret keys only, never values
- `swamp vault get <vault>` / `swamp vault describe <vault>` — show a vault's
  configuration
- `swamp vault edit [vault]` — open the vault YAML in `$EDITOR` (interactive
  search when no name is given)
- `swamp vault search [keyword]` — browse configured vaults
- `swamp vault type-search [keyword]` — browse registered vault types
  (built-in and extension)
- `swamp vault put ... --label k=v` — attach provider-native tags via
  `VaultPutOptions.tags` (repeatable)

`swamp doctor secrets` scans definitions for `sensitive: true` arguments that
hold cleartext literals instead of `vault.get(...)` expressions — see
[doctor-secrets](../enablers/doctor-secrets.md).

## CLI Secret Retrieval

The `swamp vault read-secret` command reads a secret value from a vault via CLI:

```
swamp vault read-secret <vault_name> <key> [--force] [--json]
```

This calls `VaultService.get()` — the same method used by `vault.get()` CEL
expressions — through a dedicated CLI surface. No new `VaultProvider` interface
methods are required.

### Safety Model

- **Log mode**: Prompts for confirmation before revealing the secret. Use
  `--force` (`-f`) to skip the prompt.
- **JSON mode**: Outputs directly without prompting (designed for agent/script
  consumption).
- **Audit**: Every CLI read emits a `VaultSecretRead` domain event through the
  event bus, recording the vault name, type, and secret key accessed. When
  `auditReads` is enabled on the vault, a persistent audit trail entry is also
  written to `.swamp/audit/vault-audit-YYYY-MM-DD.jsonl`. Write operations
  (`put`, `delete`, `annotate`) are always audited when an audit repository is
  available.

### JSON Output

```json
{
  "vaultName": "my-vault",
  "secretKey": "API_KEY",
  "vaultType": "local_encryption",
  "value": "sk-test-..."
}
```

## Vault Audit Trail

Audit trail that records vault operations to append-only JSONL files. Designed
for security posture verification in autonomous agent fleets — proving "which
automation accessed which secret, when, and how."

Write operations (`put`, `delete`, `annotate`) are always recorded when an audit
repository is available. Read operations (`get`) are opt-in per vault via the
`auditReads` flag.

### Enabling Read Audit

Set `auditReads: true` in the vault configuration YAML, or use the
`--audit-reads` flag at creation time:

```bash
swamp vault create local_encryption my-vault --audit-reads
```

Existing vaults can enable audit reads by editing their YAML config with
`swamp vault edit my-vault` and adding `auditReads: true`.

Write operations do not require this flag — they are always audited when the
audit repository is wired.

### How It Works

1. `VaultService.put()`, `.delete()`, `.putAnnotation()`, and
   `.deleteAnnotation()` write an audit entry after each successful operation,
   regardless of the per-vault `auditReads` flag
2. `VaultService.get()` writes an audit entry only when `auditReads` is enabled
   on that vault
3. Entries are appended to date-partitioned JSONL files:
   `.swamp/audit/vault-audit-YYYY-MM-DD.jsonl`
4. Audit writes are awaited but wrapped in try/catch — they never block or fail
   the vault operation

`VaultService.fromRepository()` always wires a `JsonlVaultAuditRepository`
(`src/domain/vaults/vault_service.ts`); `auditReads` only gates whether reads
are recorded. This covers CLI commands (`vault put`, `vault delete`,
`vault annotate`, `vault read-secret`, `vault inspect`, `vault migrate`),
expression evaluation, model method execution, serve/WebSocket, and token
operations.

### Audit Entry Fields

Each entry captures:

- `action` — the operation type: `"get"`, `"put"`, `"delete"`, or `"annotate"`
- `timestamp` — ISO-8601 when the operation occurred
- `vaultName` — which vault was accessed
- `vaultType` — the provider type (e.g. `local_encryption`, `@swamp/aws-sm`)
- `secretKey` — which secret was accessed
- `callerContext` — who/what initiated the operation. Values in use:
  `cli:vault-put`, `cli:vault-delete`, `cli:vault-inspect`,
  `cli:vault-read-secret`, `cli:vault-annotate`, `cli:vault-migrate`,
  `expression:vault-resolve` (`src/domain/expressions/model_resolver.ts`),
  `access:server-token-reveal`, `worker:token-create`,
  `model:<definition>/<method>` (`src/libswamp/models/workflow_gate.ts`), and
  `unknown`

Secret values are never recorded.

### Querying the Trail

```bash
# Recent operations (last 7 days)
swamp vault audit-trail

# Filter by vault and key
swamp vault audit-trail --vault my-vault --key API_KEY

# Filter by action
swamp vault audit-trail --action put

# Time range
swamp vault audit-trail --since 2026-07-01 --until 2026-07-10

# JSON output
swamp vault audit-trail --vault my-vault --json --limit 50
```

### Backwards Compatibility

Pre-existing audit files named `vault-reads-YYYY-MM-DD.jsonl` are still read
during queries. New entries are written to `vault-audit-YYYY-MM-DD.jsonl`.
Legacy entries without an `action` field default to `"get"` on deserialization.

### Architecture

- **Value object**: `VaultAuditEntry` (`src/domain/vaults/vault_audit_entry.ts`)
  — includes `action` discriminator field
- **Repository interface**: `VaultAuditRepository`
  (`src/domain/vaults/vault_audit_repository.ts`) — query options include
  `action` filter
- **Infrastructure**: `JsonlVaultAuditRepository` — follows the established
  `JsonlAuditRepository` pattern with date-partitioned JSONL files under
  `.swamp/audit/`, reads both legacy and current file prefixes
- **Interception**: `VaultService` records writes unconditionally when audit repo
  exists; reads are gated by per-vault `auditReads` flag.
  `setAuditRepository()` injects the repository post-construction, avoiding
  changes to the ~29 `fromRepository()` call sites

### Provider-Native Logs

For provider backends with their own access logs (AWS Secrets
Manager → CloudTrail, Azure Key Vault → Azure Monitor), swamp's native audit
trail records the swamp-level access. Surfacing/normalizing provider-native logs
is a separate feature.

## Sensitive Field Marking (Implemented)

Model schemas mark fields as sensitive using Zod's `.meta()` method. When a
method executes, sensitive output fields are automatically stored in a vault and
replaced with vault reference expressions before persistence.

### Schema Metadata

Mark individual fields as sensitive in a resource output spec schema:

```typescript
resources: {
  result: {
    schema: z.object({
      keyId: z.string(),
      keyMaterial: z.string().meta({ sensitive: true }),
      publicKey: z.string(),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
  },
},
```

Supported metadata properties on `.meta()`:

- `sensitive: boolean` - Marks the field as containing sensitive data (required)
- `vaultKey?: string` - Custom vault key (defaults to auto-generated path)
- `vaultName?: string` - Specific vault to use (overrides spec/default vault)

### Spec-Level `sensitiveOutput`

When an entire resource output is sensitive, set `sensitiveOutput: true` on the
`ResourceOutputSpec` instead of marking each field individually:

```typescript
resources: {
  result: {
    schema: z.object({ ... }),
    lifetime: "infinite",
    garbageCollection: 10,
    sensitiveOutput: true,  // All fields treated as sensitive
    vaultName: "my-vault",  // Optional: override vault for this spec
  },
},
```

### Vault Key Naming

Auto-generated vault keys are built from the model type, ID, method name, spec
name, instance name, and field path, then passed through `sanitizeVaultKey()`
(`src/domain/models/data_writer.ts`): `@` is removed, `/` and `\` become `-`,
`..` collapses to `.`, and NUL bytes are stripped:

```
{modelType}/{modelId}/{methodName}/{specName}/{instanceName}/{fieldPath}
```

For example: `@user/aws/ec2-keypair` (id `abc-123`, method `createKeyPair`,
spec `result`, instance `result`) with field `KeyMaterial` becomes
`user-aws-ec2-keypair-abc-123-createKeyPair-result-result-KeyMaterial`

Custom keys can be specified via `vaultKey` in field metadata:

```typescript
apiKey: z.string().meta({ sensitive: true, vaultKey: "my-api-key" }),
```

### Vault Reference Format

Sensitive values are replaced with CEL-compatible vault reference expressions
using single-quoted string arguments:

```
${{ vault.get('vault-name', 'vault-key') }}
```

### Shell Quoting

In `command/shell` model `run:` fields, vault expressions compile to shell
environment-variable references (`${__SWAMP_VAULT_N}`). Single quotes prevent
shell variable expansion, so wrapping a vault expression in single quotes
silently produces the literal placeholder instead of the secret value. Always use
double quotes:

```yaml
# correct — double quotes allow expansion
run: |
  PASSWORD="${{ vault.get(my-vault, DB_PASS) }}"

# WRONG — single quotes prevent expansion
run: |
  PASSWORD='${{ vault.get(my-vault, DB_PASS) }}'
```

swamp emits a warning at execution time when it detects a vault sentinel inside
single quotes.

### Vault Resolution Order

The vault used for storing a sensitive field is resolved in this order:

1. Field-level `vaultName` from `.meta()` metadata
2. Spec-level `vaultName` from `ResourceOutputSpec` (set by extension author or
   overridden via definition YAML `resources.<specName>.vaultName`)
3. Repo-level `defaultVault` from `.swamp.yaml`
4. First available vault from `VaultService`, skipping `_`-prefixed internal
   vaults (e.g. the control-plane vault) — a `_` vault is never chosen for
   user data and an explicit `_` target is rejected
   (`src/domain/models/data_writer.ts`)

### Definition-Level Vault Override

Model definition YAML can override which vault a resource's sensitive fields are
stored in, using the existing `resources` block:

```yaml
resources:
  credentials:
    vaultName: high-trust-vault
  runtime-tokens:
    vaultName: runtime-vault
```

The `vaultName` here maps to the extension's `ResourceOutputSpec` names. It
slots into the resolution order at tier 2, overriding the extension author's
default but still below any field-level `.meta()` override.

### Repo-Level Default Vault

Set a repo-wide default vault in `.swamp.yaml`:

```yaml
defaultVault: my-vault
```

This applies when no field-level or spec-level `vaultName` is set. It also
applies to `swamp serve` vault operations (OAuth credentials, device auth
tokens). If not set, the system falls back to the first available vault —
identical to the behaviour before this feature.

### Processing Behavior

- Values are **snapshotted** before processing to prevent cross-contamination
  when multiple fields are sensitive
- Non-string values are JSON-stringified before vault storage
- Fields with `null` or `undefined` values are skipped
- If sensitive fields exist but no vault is configured, an error is thrown with
  guidance to create a vault
- Processing is injected inside `createResourceWriter()` before JSON
  serialization, so it applies transparently to all resource writes

### Implementation

Processing is handled by `processSensitiveResourceData()` in
`src/domain/models/data_writer.ts`. Schema introspection is performed by
`extractSensitiveFields()` in `src/domain/models/sensitive_field_extractor.ts`.

### Input Fields

Input fields use vault expressions directly in YAML:

```yaml
keyData: ${{ vault.get('aws', 'machineKeyData') }}
```

The expression evaluation system resolves these at runtime.

## Sensitive Method Arguments

The same `z.meta({ sensitive: true })` annotation applies to **method input
argument schemas**, not just output resource schemas. Sensitive arguments are
not routed into a vault automatically — the user stores them with
`swamp vault put` and references them as `${{ vault.get(...) }}` expressions,
and the runtime rejects literal values for `sensitive: true` global arguments.
When a method argument field is marked sensitive, the framework:

1. Registers all resolved values from that field with `SecretRedactor` before
   executing the method — scrubbing them from the per-run log file automatically.
2. Applies the redactor when writing result resource attributes — scrubbing
   sensitive values even if the extension model writes them into result attributes.
3. Redacts the field to `"***"` in the auto-generated method summary reports
   (both Markdown and JSON variants).

### Marking an Argument Field as Sensitive

```typescript
methods: {
  exec: {
    description: "Run a command in the container",
    arguments: z.object({
      // command may contain credentials — mark it sensitive
      command: z.array(z.string()).meta({ sensitive: true }),
      workdir: z.string().optional(),
    }),
    execute: async (args, context) => { ... },
  },
},
```

String and string-array values are both supported. For array fields, each element
is individually registered with the redactor so any occurrence of any element in
log output is scrubbed.

### Behavior Comparison

| Location | Output schema `sensitive: true` | Argument schema `sensitive: true` |
| -------- | ------------------------------- | --------------------------------- |
| Result resource attributes | Stored in vault, replaced with vault ref | Scrubbed by redactor at write time |
| Per-run log file | Vault secrets scrubbed | Argument values scrubbed |
| Method summary report | Rendered as vault ref | Rendered as `***` |
| Audit log | Not covered | Not covered |

Use output-schema sensitive marking when the value must be retrievable later via
`vault.get()`. Use argument-schema sensitive marking when the value is a
short-lived credential that should never be stored anywhere.

## External Providers Are Extensions

The only built-in vault type registered in `vaultTypeRegistry` is
`local_encryption` (`src/domain/vaults/vault_types.ts`); `mock` is compiled in
for tests but not registered as a user-facing type. Every other backend is an
extension that exports `export const vault` with a `createProvider` factory —
`@swamp/aws-sm`, `@swamp/azure-kv`, and `@swamp/1password` are the first-party
ones. Their configuration, key mapping, and authentication behaviour are
documented in those extensions, not here.

What this repository does for an extension vault type:

- **Type registry**: `createVaultProvider()`
  (`src/domain/vaults/vault_provider_factory.ts`) looks the type up in
  `vaultTypeRegistry`, validates `config` against the type's optional
  `configSchema`, calls `createProvider(name, config)`, and asserts the result
  implements `VaultProvider`. Missing `@collective/...` types are auto-resolved
  from trusted collectives on load.
- **Renamed-type remap**: legacy type strings (`aws`, `aws-sm`, `azure`,
  `azure-kv`, `1password`) are mapped to their extension names by
  `RENAMED_VAULT_TYPES` (`src/domain/vaults/vault_types.ts`).
  `VaultService.fromRepository()` remaps them transparently and logs a warning
  asking the user to update the config file.
- **Configuration**: each vault is one YAML file under
  `vaults/{vault-type}/{id}.yaml`. Provider-specific settings are passed as
  JSON at creation time and stored under `config`:

  ```bash
  swamp vault create @swamp/1password my-vault --config '{"op_vault":"Engineering"}'
  swamp vault create local_encryption my-vault --audit-reads
  ```

  `vault create` accepts only `--config <json>` and `--audit-reads`
  (`src/cli/commands/vault_create.ts`); there are no provider-specific flags.
- **No implicit vaults**: `VaultService.ensureDefaultVaults()` is a no-op kept
  for its call site — it used to auto-create an AWS vault when credentials were
  present. Vault names starting with `_` are reserved for swamp-internal use
  (e.g. the control-plane vault) and are never chosen as a fallback for user
  data.

## Workflow Integration

Vaults integrate seamlessly with the expression evaluation system:

### Dependency Resolution

When a vault expression is encountered:

1. The vault name is resolved from repository configuration
2. The appropriate vault provider is instantiated
3. The secret is retrieved during expression evaluation
4. The value is injected into the final data structure

### Lazy Evaluation

Vault access is lazy - secrets are only retrieved when expressions are
evaluated, ensuring:

- Minimal credential usage
- Fresh secret values for each workflow run
- Proper error handling at evaluation time

### Caching Strategy

- **No Caching**: Secrets are not cached between workflow runs, and every
  `vault.get` match is resolved independently through `VaultService.get()`
  (`resolveVaultExpressions` in `src/domain/expressions/model_resolver.ts`)

## Security Considerations

### Credential Management

- Never store provider credentials in workflow files or version control
- Use IAM roles and policies for fine-grained access control
- Rotate credentials regularly and update vault configurations accordingly

### Secret Access Patterns

- Use descriptive but not revealing secret names
- Implement least-privilege access to specific secrets
- Monitor vault access through provider audit logs

### Expression Security

- Vault secrets resolved via `vault.get()` are automatically redacted from
  stdout/stderr output, log files, and persisted data artifacts
- Redaction replaces secret values with `***` using the `SecretRedactor`
- The redactor is threaded through `MethodContext` and available to all model
  implementations
- Expression evaluation errors don't expose secret values

## Vault Migration

The `swamp vault migrate` command migrates a vault to a different backend type
in-place. The vault name stays the same, so all existing vault reference
expressions continue to work without modification.

### Usage

```
swamp vault migrate <vault-name> --to-type <target-type> [--config <json>] [--dry-run]
```

### How It Works

1. Lists all secret keys in the source vault
2. Copies each secret value from the current backend to a new provider instance
3. Updates the vault configuration file to point to the new backend type
   (save-new first, then delete-old)
4. The vault name is preserved — all existing `vault.get('name', 'key')`
   expressions resolve identically after migration

### Safety Model

- **Secrets are copied, not moved.** The source backend retains its secrets until
  the config file is deleted. If anything fails during copy, the original vault
  remains fully functional.
- **Config swap ordering.** The new config file is written before the old one is
  removed. If the delete fails, an orphaned config file remains but the vault
  works correctly on the new backend.
- **Same-type migrations are rejected.** The target type must differ from the
  current type.
- **Dry-run support.** Use `--dry-run` to preview the migration (secret count,
  type change) without making any changes.

### Provider Factory

Provider instantiation is handled by a shared factory function
(`createVaultProvider` in `src/domain/vaults/vault_provider_factory.ts`) that
supports both built-in types (local_encryption, mock) and extension types
registered in the vault type registry. This factory is used by both
`VaultService.registerVault()` and the migrate operation, ensuring consistent
provider creation behavior.

## Extensibility

The built-in `switch` in `createVaultProvider()` is closed — it handles only
`mock` and `local_encryption`. New vault types are added as extensions, never by
editing the factory:

1. In an extension, export `vault` with `type`, `name`, `description`, an
   optional `configSchema`, and `createProvider(name, config)` returning an
   object that implements `VaultProvider` (plus any of the optional annotation,
   refresh hook, or delete interfaces).
2. The vault loader registers it in `vaultTypeRegistry`
   (`src/domain/vaults/vault_type_registry.ts`); the factory prefers registry
   entries over built-ins for any non-built-in type.
3. Users create instances with `swamp vault create <type> <name> --config
   <json>`.

## Error Handling

Comprehensive error handling covers:

### Configuration Errors

- Invalid vault names or missing configurations
- Malformed provider-specific settings
- Authentication credential issues

### Runtime Errors

- Network connectivity problems
- Secret not found in vault
- Permission denied accessing specific secrets
- Vault service unavailable

### Expression Evaluation Errors

- Vault name not found in configuration
- Invalid key format or characters
- Circular dependencies in vault expressions

All errors include:

- Clear error messages with context
- Vault name and key information (when safe to expose)
- Suggested resolution steps
- Reference to relevant documentation sections
