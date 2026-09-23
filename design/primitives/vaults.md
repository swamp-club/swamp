---
audience: maintainer, operator
last-verified: 2026-09-15 @ uncommitted
---

# swamp vaults

A swamp vault stores secrets that workflows and models use through named vault
configurations. It puts one interface over different secret management
systems.

## Architecture

- **Named Vaults**: each vault has a user-defined name, configured in
  `vaults/{vault-type}/{id}.yaml`. Under `managedConfig: true` the configs live
  in the datastore's `config/vaults/` tier instead. When the caller passes no
  `vaultsDir`, `VaultService.fromRepository()` finds them through the managed
  config registry, so `vault.get()` expressions, serve and CLI commands all
  read the same configs.
- **Vault Types**: each vault names its storage system. `local_encryption` is
  built in; `@swamp/aws-sm`, `@swamp/azure-kv` and `@swamp/1password` are
  extensions.
- **Clean Interface**: all vaults implement one common interface.
- **Expression Integration**: vaults are read in CEL expressions with
  `${{ vault.get(vault_name, key) }}`.

## Secret Storage

Secrets are stored in the datastore `secrets/` directory (default
`.swamp/secrets/`), by vault type and name:

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

The secrets path is computed at runtime by the datastore path resolver. The
vault configuration stores `base_dir` (the repository root), and the datastore
layer derives the full path ([datastores](../enablers/datastores.md)).

## Vault Provider Interface

Every vault implementation must implement `VaultProvider`:

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

Annotations are optional metadata on secrets: URL, notes, labels. A provider
that implements `VaultAnnotationProvider` alongside `VaultProvider` supports
them; other providers are unaffected.

```typescript
interface VaultAnnotationProvider {
  getAnnotation(secretKey: string): Promise<VaultAnnotation | null>;
  putAnnotation(secretKey: string, annotation: VaultAnnotation): Promise<void>;
  deleteAnnotation(secretKey: string): Promise<void>;
  listAnnotations(): Promise<Map<string, VaultAnnotation>>;
}
```

Support is detected by a runtime type guard (`isVaultAnnotationProvider()`),
not by compile-time types. An extension provider opts in when its
`createProvider` returns an object that implements both interfaces.

## Vault Refresh Hook Provider Interface

Refresh hooks are optional per-secret metadata that tell swamp how to refresh
short-lived credentials. Providers opt in by implementing
`VaultRefreshHookProvider` alongside `VaultProvider`.

```typescript
interface VaultRefreshHookProvider {
  getRefreshHook(secretKey: string): Promise<RefreshHook | null>;
  putRefreshHook(secretKey: string, hook: RefreshHook): Promise<void>;
  deleteRefreshHook(secretKey: string): Promise<void>;
}
```

Detection uses a runtime type guard (`isVaultRefreshHookProvider()`), as with
annotations.

## Vault Delete Provider Interface

Deleting secrets is also opt-in, via `VaultDeleteProvider` alongside
`VaultProvider`. Other providers report "unsupported" to `swamp vault delete`.

```typescript
interface VaultDeleteProvider {
  delete(secretKey: string): Promise<void>;
}
```

Detection uses a runtime type guard (`isVaultDeleteProvider()`), as above.
`VaultService.delete()` only calls `provider.delete()`
(`src/domain/vaults/vault_service.ts`). The `local_encryption` provider's own
`delete()` also removes the secret's annotation and refresh hook, best-effort
(`src/domain/vaults/local_encryption_vault_provider.ts`). Extension providers
must do their own cascade.

The built-in providers (`local_encryption`, `mock`) implement this interface.
Extension providers (e.g. `@swamp/1password`, `@swamp/aws-sm`) opt in the same
way as for annotations.

### Refresh Hook Value Object

`RefreshHook` is an immutable value object:

- `command: string`: the shell command to run (e.g.
  `gcloud auth print-access-token`)
- `ttlMs: number`: milliseconds until the value is stale
- `lastRefreshedAt: Date | null`: when the value was last refreshed (UTC)

The value is stale when `Date.now() - lastRefreshedAt.getTime() >= ttlMs`. Both
sides are UTC, so the local timezone plays no part.

### Refresh-on-Read Behavior

When `VaultService.get()` is called with refresh options configured:

1. Check whether the provider supports refresh hooks.
2. If a hook exists for the key, check whether the value is stale.
3. If stale, run the command via `executeProcess` and trim trailing whitespace
   from stdout. Write the new value back via `provider.put()`, update
   `lastRefreshedAt`, and return the new value.
4. If the command fails, or succeeds with empty stdout, log a warning and
   return the stale value. An empty result is never written back.

This is invisible to callers: `vault.get()` in CEL expressions and workflows
refreshes with no extra workflow code.

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

The built-in `local_encryption` provider stores refresh hooks as encrypted JSON
in a `.refresh/` subdirectory next to `.annotations/`:

```
.swamp/secrets/local_encryption/{vault-name}/
  GCP_TOKEN.enc              # encrypted secret value
  .annotations/
    GCP_TOKEN.enc            # encrypted annotation metadata
  .refresh/
    GCP_TOKEN.enc            # encrypted refresh hook config
```

### Annotation Storage (local_encryption)

The built-in `local_encryption` provider stores annotations as encrypted files
under `.annotations/`:

```
.swamp/secrets/local_encryption/{vault-name}/
  my-api-key.enc          # encrypted secret value
  .annotations/
    my-api-key.enc        # encrypted annotation (same AES-GCM key)
```

The subdirectory avoids filename clashes with secret keys that end in `.meta`
or similar suffixes.

### Annotation CLI

```
swamp vault annotate <vault> <key> --url <u> --notes <text> --label <k=v>
swamp vault annotate <vault> <key> --remove-label <key>
swamp vault inspect <vault> <key>
swamp vault annotate <vault> <key> --clear
```

Annotations merge: only the fields given as flags change, and other fields are
kept. `--remove-label` removes one label by key and can be repeated. `--clear`
removes all annotations and cannot be combined with other annotation flags.

### Vault Inspect Output

`swamp vault inspect <vault> <key>` shows all metadata for a vault item without
the secret value:

- `sizeBytes`: byte length of the stored value (UTF-8)
- `sizeChars`: character count of the stored value
- `valueType`: always `"string"` (the provider interface stores strings)
- `annotation`: url, notes, labels, updatedAt (if the provider supports
  annotations)
- `refreshHook`: command, ttl, lastRefreshedAt (if the provider supports
  refresh hooks)

If a provider lacks annotations or refresh hooks, those fields are `null`, and
the `supportsAnnotations` / `supportsRefreshHooks` booleans tell "not supported"
from "supported but empty."

The secret value is never returned. A deps factory function calls `get()` and
returns only the byte length, so the secret never enters the operation's
scope.

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

Expressions read vaults with `vault.get()`:

```yaml
# Basic vault access
keyData: ${{ vault.get(aws, machineKeyData) }}

# Different vault for different environments
prodSecret: ${{ vault.get(prod-vault, apiKey) }}
devSecret: ${{ vault.get(dev-vault, apiKey) }}
```

In `vault.get(vault_name, key)`, `vault_name` names a configured vault and
`key` is the secret's identifier in that vault.

`vault.get` is not a CEL function. A regex matches it and substitutes it before
CEL evaluation (`resolveVaultExpressions` in
`src/domain/expressions/model_resolver.ts`). Each match is resolved through
`VaultService.get()` and replaced with a sentinel string, or with an escaped
literal when there is no secret bag. There is no `vault.put` expression. Writes
go through `swamp vault put` or sensitive-field marking (below).

Arguments can be quoted literals or bare-token CEL expressions. Bare tokens
containing `.` (e.g. `inputs.vaultName`) are evaluated as CEL against the
runtime context before the lookup. See
[expressions.md § Dynamic Vault Arguments](../enablers/expressions.md#dynamic-vault-arguments)
for details, security notes and known limits.

## CLI Surface

Vault commands live in `src/cli/commands/vault_*.ts`. `create`, `put`,
`delete`, `annotate`, `inspect`, `migrate`, `audit-trail` and `read-secret`
have their own sections. The group also has:

- `swamp vault list-keys <vault>`: secret keys only, never values
- `swamp vault get <vault>` / `swamp vault describe <vault>`: show a vault's
  configuration
- `swamp vault edit [vault]`: open the vault YAML in `$EDITOR` (interactive
  search when no name is given)
- `swamp vault search [keyword]`: browse configured vaults
- `swamp vault type-search [keyword]`: browse registered vault types
  (built-in and extension)
- `swamp vault put ... --label k=v`: attach provider-native tags via
  `VaultPutOptions.tags` (repeatable)

`swamp doctor secrets` finds `sensitive: true` arguments in definitions that
hold cleartext literals instead of `vault.get(...)` expressions
([doctor-secrets](../enablers/doctor-secrets.md)).

## CLI Secret Retrieval

`swamp vault read-secret` reads a secret value from a vault:

```
swamp vault read-secret <vault_name> <key> [--force] [--json]
```

It calls `VaultService.get()`, the same method `vault.get()` CEL expressions
use. It needs no new `VaultProvider` interface methods.

### Safety Model

- **Log mode**: asks for confirmation before showing the secret. `--force`
  (`-f`) skips the prompt.
- **JSON mode**: prints without prompting, for agents and scripts.
- **Audit**: every CLI read emits a `VaultSecretRead` domain event on the event
  bus with the vault name, type and secret key. If the vault has `auditReads`
  enabled, an entry is also written to
  `.swamp/audit/vault-audit-YYYY-MM-DD.jsonl`. Writes (`put`, `delete`,
  `annotate`) are always audited when an audit repository is available.

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

The audit trail records vault operations in append-only JSONL files. It lets
teams running autonomous agents prove which automation accessed which secret,
when, and how. Writes (`put`, `delete`, `annotate`) are always recorded when an
audit repository is available. Reads (`get`) are recorded only for vaults with
the `auditReads` flag.

### Enabling Read Audit

Set `auditReads: true` in the vault configuration YAML, or pass `--audit-reads`
when creating the vault:

```bash
swamp vault create local_encryption my-vault --audit-reads
```

For an existing vault, run `swamp vault edit my-vault` and add
`auditReads: true`. Writes do not need this flag.

### How It Works

1. `VaultService.put()`, `.delete()`, `.putAnnotation()` and
   `.deleteAnnotation()` write an audit entry after each successful call,
   whatever the vault's `auditReads` setting.
2. `VaultService.get()` writes an entry only when the vault has `auditReads`
   enabled.
3. Entries are appended to one JSONL file per day:
   `.swamp/audit/vault-audit-YYYY-MM-DD.jsonl`.
4. Audit writes are awaited but wrapped in try/catch, so they never block or
   fail the vault operation.

`VaultService.fromRepository()` always wires a `JsonlVaultAuditRepository`
(`src/domain/vaults/vault_service.ts`); `auditReads` only controls whether reads
are recorded. This covers CLI commands (`vault put`, `vault delete`,
`vault annotate`, `vault read-secret`, `vault inspect`, `vault migrate`),
expression evaluation, model method execution, serve/WebSocket and token
operations.

### Audit Entry Fields

- `action`: `"get"`, `"put"`, `"delete"` or `"annotate"`
- `timestamp`: ISO-8601 time of the operation
- `vaultName`: the vault accessed
- `vaultType`: the provider type (e.g. `local_encryption`, `@swamp/aws-sm`)
- `secretKey`: the secret accessed
- `callerContext`: who or what started the operation. Values in use:
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

Queries still read older files named `vault-reads-YYYY-MM-DD.jsonl`. New entries
go to `vault-audit-YYYY-MM-DD.jsonl`. Legacy entries with no `action` field
read as `"get"`.

### Architecture

- **Value object**: `VaultAuditEntry` (`src/domain/vaults/vault_audit_entry.ts`)
  has an `action` discriminator field.
- **Repository interface**: `VaultAuditRepository`
  (`src/domain/vaults/vault_audit_repository.ts`); query options include an
  `action` filter.
- **Infrastructure**: `JsonlVaultAuditRepository` follows the existing
  `JsonlAuditRepository` pattern: one JSONL file per day under `.swamp/audit/`.
  It reads both the legacy and current file prefixes.
- **Interception**: `VaultService` always records writes when an audit repo
  exists; the per-vault `auditReads` flag controls reads.
  `setAuditRepository()` injects the repository after construction, so the ~29
  `fromRepository()` call sites did not have to change.

### Provider-Native Logs

Some backends keep their own access logs (AWS Secrets Manager → CloudTrail,
Azure Key Vault → Azure Monitor). swamp's audit trail records the swamp-level
access. Surfacing or normalizing provider-native logs is a separate feature.

## Sensitive Field Marking (Implemented)

Model schemas mark fields as sensitive with Zod's `.meta()` method. When a
method runs, sensitive output fields go to a vault and are replaced with vault
reference expressions before saving.

### Schema Metadata

Mark individual fields in a resource output spec schema:

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

Supported `.meta()` properties:

- `sensitive: boolean`: marks the field as sensitive (required)
- `vaultKey?: string`: custom vault key (defaults to a generated path)
- `vaultName?: string`: vault to use (overrides the spec or default vault)

### Spec-Level `sensitiveOutput`

If a whole resource output is sensitive, set `sensitiveOutput: true` on the
`ResourceOutputSpec` instead of marking each field:

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

Generated vault keys are built from the model type, ID, method name, spec name,
instance name and field path. They then pass through `sanitizeVaultKey()`
(`src/domain/models/data_writer.ts`): `@` is removed, `/` and `\` become `-`,
`..` collapses to `.`, and NUL bytes are stripped:

```
{modelType}/{modelId}/{methodName}/{specName}/{instanceName}/{fieldPath}
```

For example, `@user/aws/ec2-keypair` (id `abc-123`, method `createKeyPair`,
spec `result`, instance `result`) with field `KeyMaterial` becomes
`user-aws-ec2-keypair-abc-123-createKeyPair-result-result-KeyMaterial`.

Set a custom key with `vaultKey` in field metadata:

```typescript
apiKey: z.string().meta({ sensitive: true, vaultKey: "my-api-key" }),
```

### Vault Reference Format

Sensitive values are replaced with CEL-compatible vault reference expressions
that use single-quoted string arguments:

```
${{ vault.get('vault-name', 'vault-key') }}
```

### Shell Quoting

In `command/shell` model `run:` fields, vault expressions compile to
environment-variable references: `${__SWAMP_VAULT_N}` on POSIX and
`$env:__SWAMP_VAULT_N` on native Windows PowerShell. Single quotes stop
expansion in both shells, so a single-quoted vault expression silently yields
the literal placeholder. Always use double quotes:

```yaml
# correct on POSIX — double quotes allow expansion
run: |
  PASSWORD="${{ vault.get(my-vault, DB_PASS) }}"

# correct on native Windows PowerShell
run: |
  Write-Output "${{ vault.get(my-vault, DB_PASS) }}"

# WRONG — single quotes prevent expansion in both shells
run: |
  PASSWORD='${{ vault.get(my-vault, DB_PASS) }}'
```

swamp warns at execution time when it finds a vault sentinel inside single
quotes.

### Vault Resolution Order

The vault for a sensitive field is chosen in this order:

1. Field-level `vaultName` from `.meta()`.
2. Spec-level `vaultName` from `ResourceOutputSpec`. The extension author sets
   it; definition YAML can override it with `resources.<specName>.vaultName`.
3. Repo-level `defaultVault` from `.swamp.yaml`.
4. The first available vault from `VaultService`, skipping `_`-prefixed
   internal vaults (e.g. the control-plane vault). A `_` vault is never chosen
   for user data, and an explicit `_` target is rejected
   (`src/domain/models/data_writer.ts`).

### Definition-Level Vault Override

Model definition YAML can choose the vault for a resource's sensitive fields in
the existing `resources` block:

```yaml
resources:
  credentials:
    vaultName: high-trust-vault
  runtime-tokens:
    vaultName: runtime-vault
```

The keys are the extension's `ResourceOutputSpec` names. This is tier 2 of the
resolution order: above the extension author's default, below field-level
`.meta()`.

### Repo-Level Default Vault

Set a repo-wide default vault in `.swamp.yaml`:

```yaml
defaultVault: my-vault
```

It applies when no field-level or spec-level `vaultName` is set. It also applies
to `swamp serve` vault operations (OAuth credentials, device auth tokens).
Without it, swamp falls back to the first available vault, as it did before
this feature.

### Processing Behavior

- Values are snapshotted before processing, so several sensitive fields do
  not contaminate each other.
- Non-string values are JSON-stringified before they are stored.
- Fields with `null` or `undefined` values are skipped.
- If there are sensitive fields but no vault, swamp throws an error that says
  to create a vault.
- Processing runs inside `createResourceWriter()` before JSON serialization, so
  it applies to every resource write.

### Read-Side Resolution

When resource data is read back (via `readResource`, `data get` or CEL
expressions), vault references in sensitive fields resolve to the original
secrets. A non-sensitive field holding a vault-reference-shaped string stays
literal text.

A `_swamp.sensitiveFields` tag written at save time lists the dot-paths of
vaulted fields, or `*` for `sensitiveOutput: true`. Read sites parse it to pick
the fields to resolve. For legacy data without the tag, call sites with schema
access fall back to `extractSensitiveFields()` on the resource spec; those
without skip resolution (secure default).

`resolveSensitiveVaultRefs()` does the resolution and
`parseSensitiveFieldsTag()` parses the tag, both in
`src/domain/models/data_writer.ts`.

### Implementation

`processSensitiveResourceData()` does the processing
(`src/domain/models/data_writer.ts`). `extractSensitiveFields()` reads the
schema (`src/domain/models/sensitive_field_extractor.ts`).

### Input Fields

Input fields use vault expressions directly in YAML:

```yaml
keyData: ${{ vault.get('aws', 'machineKeyData') }}
```

Expression evaluation resolves these at runtime.

## Sensitive Method Arguments

The same `z.meta({ sensitive: true })` annotation also works on method input
argument schemas. These are not sent to a vault automatically: the user stores
them with `swamp vault put` and refers to them as `${{ vault.get(...) }}`
expressions. The runtime rejects literal values for `sensitive: true` global
arguments. For a sensitive argument field, the framework:

1. Registers every resolved value of the field with `SecretRedactor` before the
   method runs, which scrubs them from the per-run log file.
2. Applies the redactor when writing result resource attributes, so the values
   are scrubbed even if the extension model writes them there.
3. Shows the field as `"***"` in the generated method summary reports (Markdown
   and JSON).

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

String and string-array values are both supported. For arrays, each element is
registered with the redactor on its own, so any element found in log output is
scrubbed.

### Behavior Comparison

| Location | Output schema `sensitive: true` | Argument schema `sensitive: true` |
| -------- | ------------------------------- | --------------------------------- |
| Result resource attributes | Stored in vault, replaced with vault ref | Scrubbed by redactor at write time |
| Per-run log file | Vault secrets scrubbed | Argument values scrubbed |
| Method summary report | Rendered as vault ref | Rendered as `***` |
| Audit log | Not covered | Not covered |

Mark the output schema when the value must be readable later via `vault.get()`.
Mark the argument schema when the value is a short-lived credential that should
never be stored.

## External Providers Are Extensions

`local_encryption` is the only built-in vault type registered in
`vaultTypeRegistry` (`src/domain/vaults/vault_types.ts`). `mock` is compiled in
for tests but not registered for users. Every other backend is an extension
that exports `export const vault` with a `createProvider` factory. The
first-party ones are `@swamp/aws-sm`, `@swamp/azure-kv` and `@swamp/1password`.
Their configuration, key mapping and authentication are documented in those
extensions.

What this repository does for an extension vault type:

- **Type registry**: `createVaultProvider()` looks the type up in
  `vaultTypeRegistry` and validates `config` against the type's optional
  `configSchema`. It then calls `createProvider(name, config)` and asserts the
  result implements `VaultProvider`
  (`src/domain/vaults/vault_provider_factory.ts`). Missing `@collective/...`
  types are resolved from trusted collectives on load.
- **Renamed-type remap**: `RENAMED_VAULT_TYPES` maps legacy type strings
  (`aws`, `aws-sm`, `azure`, `azure-kv`, `1password`) to their extension names
  (`src/domain/vaults/vault_types.ts`). `VaultService.fromRepository()` remaps
  them and logs a warning asking the user to update the config file.
- **Configuration**: each vault is one YAML file under
  `vaults/{vault-type}/{id}.yaml`. Provider-specific settings are passed as
  JSON at creation and stored under `config`:

  ```bash
  swamp vault create @swamp/1password my-vault --config '{"op_vault":"Engineering"}'
  swamp vault create local_encryption my-vault --audit-reads
  ```

  `vault create` accepts only `--config <json>` and `--audit-reads`; there are
  no provider-specific flags (`src/cli/commands/vault_create.ts`).
- **No implicit vaults**: `VaultService.ensureDefaultVaults()` does nothing and
  is kept for its call site. It used to create an AWS vault when credentials
  were present. Vault names starting with `_` are reserved for swamp's own use
  (e.g. the control-plane vault) and are never a fallback for user data.

## Workflow Integration

### Dependency Resolution

For each vault expression:

1. The vault name is resolved from repository configuration.
2. The matching vault provider is created.
3. The secret is fetched during expression evaluation.
4. The value is put into the final data structure.

### Lazy Evaluation

Secrets are fetched only when expressions are evaluated. This keeps credential
use low, gives each workflow run fresh values, and surfaces errors at
evaluation time.

### Caching Strategy

- **No Caching**: secrets are not cached between workflow runs. Each
  `vault.get` match is resolved separately through `VaultService.get()`
  (`resolveVaultExpressions` in `src/domain/expressions/model_resolver.ts`).

## Security Considerations

### Credential Management

- Never store provider credentials in workflow files or version control.
- Use IAM roles and policies for fine-grained access control.
- Rotate credentials regularly and update vault configurations to match.

### Secret Access Patterns

- Give secrets descriptive names that do not reveal their contents.
- Grant least-privilege access to specific secrets.
- Monitor vault access through provider audit logs.

### Expression Security

- Secrets resolved via `vault.get()` are redacted from stdout/stderr, log files
  and saved data artifacts.
- The `SecretRedactor` replaces secret values with `***`.
- The redactor is passed through `MethodContext`, so every model
  implementation can use it.
- Expression evaluation errors do not expose secret values.

## Vault Migration

`swamp vault migrate` moves a vault to a different backend type in place. The
vault name stays the same, so existing vault reference expressions keep
working.

### Usage

```
swamp vault migrate <vault-name> --to-type <target-type> [--config <json>] [--dry-run]
```

### How It Works

1. List all secret keys in the source vault.
2. Copy each secret value from the current backend to a new provider instance.
3. Point the vault configuration file at the new backend type (save the new
   file first, then delete the old one).
4. The name is unchanged, so every `vault.get('name', 'key')` expression
   resolves the same after migration.

### Safety Model

- **Secrets are copied, not moved.** The source backend keeps its secrets until
  the config file is deleted, so a failed copy leaves the original vault
  working.
- **Config swap ordering.** The new config file is written before the old one is
  removed. If the delete fails, an orphaned config file is left, but the vault
  works on the new backend.
- **Same-type migrations are rejected.** The target type must differ from the
  current one.
- **Dry-run support.** `--dry-run` previews the migration (secret count, type
  change) without changing anything.

### Provider Factory

One shared factory creates providers (`createVaultProvider` in
`src/domain/vaults/vault_provider_factory.ts`). It supports the built-in types
(local_encryption, mock) and extension types in the vault type registry. Both
`VaultService.registerVault()` and the migrate operation use it, so providers
are always created the same way.

## Extensibility

The built-in `switch` in `createVaultProvider()` is closed: it handles only
`mock` and `local_encryption`. New vault types are added as extensions, never by
editing the factory:

1. In an extension, export `vault` with `type`, `name`, `description`, an
   optional `configSchema`, and `createProvider(name, config)`. It returns an
   object that implements `VaultProvider`, plus any of the optional annotation,
   refresh hook or delete interfaces.
2. The vault loader registers it in `vaultTypeRegistry`
   (`src/domain/vaults/vault_type_registry.ts`). For any non-built-in type, the
   factory uses registry entries before built-ins.
3. Users create instances with `swamp vault create <type> <name> --config
   <json>`.

## Error Handling

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

All errors include a clear message with context, the vault name and key (when
safe to show), suggested fixes, and a pointer to the relevant documentation.
