---
audience: maintainer
enables: [vaults]
last-verified: 2026-08-28 @ 3d5955a9
---

# Doctor Vaults — sensitive-output vault availability scan

`swamp doctor vaults` is a read-only check. It reports model definitions whose
resource output schemas have sensitive fields (`{ sensitive: true }` metadata or
`sensitiveOutput: true` on the spec) when the repository has no vault. It exits
non-zero on any finding, so CI can gate on it.

## Why it exists

Models whose resource outputs hold sensitive data (credentials, API keys,
private keys) need a vault to store it. Without one, the method fails when it
saves output, after it has already run and possibly created cloud resources
that now cannot be recorded.

swamp-club#562 added two runtime guards:

1. **Pre-flight check** in `DefaultMethodExecutionService.executeWorkflow()`
   (`src/domain/models/method_execution_service.ts`). Before a mutating
   method (`isMutatingKind`) starts, it fails with a `UserError` if the model's
   resource output specs have sensitive fields and no vault is configured. No
   API calls are made and no cloud resources are created. Read and list methods
   skip this check.

2. **Defense-in-depth** in `createResourceWriter()`. A write for a spec with
   sensitive fields and no `vaultService` throws rather than writing plaintext.

`doctor vaults` is the validation-time counterpart. It scans every model
definition ahead of time, so users find the problem before they even attempt a
`method run`.

## What it scans

The same two trees as `doctor secrets`:

- Source-of-truth definitions under `models/`.
- Auto-created definitions under `.swamp/auto-definitions`.

For each definition it resolves the model type from the registry and asks
whether any `ResourceOutputSpec` needs a vault (`modelRequiresVault()` in
`data_writer.ts`). A spec needs one when:

- any field in its Zod schema has `.meta({ sensitive: true })`, or
- it has `sensitiveOutput: true` (all fields count as sensitive).

If a spec needs a vault and the repository has none, the definition is reported.

## Vault availability

The scan builds a `VaultService` with `VaultService.fromRepository(repoDir)` and
checks `getUserVaultNames().length > 0`, meaning at least one user vault is
configured (`src/libswamp/models/doctor_vaults.ts`). Reserved vaults, such as
the `_token-secrets` control-plane vault that serve registers in every
`VaultService`, are not counted: sensitive data is never stored in them. The
runtime pre-flight and `processSensitiveResourceData` use the same check.

## Best-effort residual

As in `doctor secrets`, definitions whose type cannot be resolved are reported
as unresolved: advisory, not silent.

## Out of scope

The scan does not check that the vault works (e.g. encryption keys present,
provider reachable). The vault provider handles that at runtime.
