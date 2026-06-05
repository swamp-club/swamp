# Doctor Vaults — sensitive-output vault availability scan

`swamp doctor vaults` is a read-only diagnostic that reports model definitions
whose resource output schemas contain sensitive fields (`{ sensitive: true }`
metadata or `sensitiveOutput: true` on the spec) when no vault is configured in
the repository. It exits non-zero when any finding is present, so CI can gate
on it.

## Why it exists

Models that produce sensitive data in their resource outputs (credentials, API
keys, private key material) rely on a configured vault to store those values
securely. Without a vault, the method execution fails at persist time — but only
after the method has already run, potentially creating cloud resources that
cannot be recorded.

swamp-club#562 added two runtime guards:

1. **Pre-flight check** in `MethodExecutionService.executeWorkflow()` — before
   method execution begins, if the model's resource output specs contain
   sensitive fields and no vault is configured, the method fails immediately
   with a `UserError`. No API calls are made, no cloud resources are created.

2. **Defense-in-depth** in `createResourceWriter()` — if a resource write is
   attempted for a spec with sensitive fields and no `vaultService` is
   available, it throws an explicit error instead of silently writing plaintext.

`doctor vaults` is the validation-time counterpart: it scans all model
definitions proactively so users discover the mismatch before they even attempt
a `method run`.

## What it scans

It enumerates the same two definition trees as `doctor secrets`:

- Source-of-truth definitions under `models/`.
- Auto-created definitions under `.swamp/auto-definitions`.

For each definition, it resolves the model type from the registry and checks
whether any `ResourceOutputSpec` requires a vault (via `modelRequiresVault()`
in `data_writer.ts`). A spec requires a vault when:

- Any field in the spec's Zod schema has `.meta({ sensitive: true })`, or
- The spec has `sensitiveOutput: true` (all fields treated as sensitive).

If any spec requires a vault and no vault is configured in the repository, the
definition is reported as a finding.

## Vault availability

Vault availability is checked by instantiating a `VaultService` from the
repository and verifying at least one vault provider is registered. This is the
same check the runtime pre-flight uses.

## Best-effort residual

Like `doctor secrets`, definitions whose type cannot be resolved are reported
as unresolved — advisory, not silent.

## Out of scope

This scan does not check whether the configured vault is _functional_ (e.g.
encryption keys present, provider reachable). That is a runtime concern handled
by the vault provider itself.
