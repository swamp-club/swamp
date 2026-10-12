---
audience: maintainer
enables: [models]
last-verified: 2026-08-28 @ 3d5955a9
---

# Doctor Secrets — cleartext sensitive-argument scan

`swamp doctor secrets` is a read-only check. It reports model definitions whose
`sensitive: true` global arguments hold a **cleartext literal** instead of a
`vault.get(...)` expression. Each finding includes fix steps, in log and JSON
output. It exits non-zero when any leak is found, so CI can gate on it.

## Why it exists

swamp-club#480 (PR #1469) made `YamlDefinitionRepository.save()`, the single
write path for definitions, refuse a literal for a sensitive global argument.
That only covers new writes. Two gaps remain that a write-time guard cannot
close:

1. **Legacy definitions** from before the guard keep the cleartext until
   re-saved.
2. **Datastore sync / migration** copies definition YAML byte for byte, so a
   literal from an older swamp or another machine can reach disk without
   `save()`.

`doctor secrets` finds these on disk and points to the fix. It does not fix
them. The user moves the secret to a vault and re-saves.

## What it scans

- Source-of-truth definitions under `models/`. Synced and pulled definitions
  land here.
- Locally auto-created definitions under `.swamp/auto-definitions`.

The public `findAllGlobal()` walks only its own `baseDir`, so a second
`YamlDefinitionRepository` reads the auto-definitions tree and the results are
joined (`src/libswamp/models/doctor_secrets.ts`).

## The rule it applies

The scan uses the same domain rule as the write guard,
`findLiteralSensitiveGlobalArgs`
(`src/domain/models/sensitive_field_extractor.ts`), so it reports exactly what a
re-save would refuse. Fix steps come from `buildSensitiveArgRemediations`, the
structured form of the guard's `literalSensitiveGlobalArgsMessage`. Both give
the same fix: store the secret in a vault and reference it with
`vault.get(...)`. The scan adds vault coordinates per path, which a renderer can
print as concrete commands.

## Read-only and value-free

- **Read-only.** It never calls `save()`, so it never trips the guard or changes
  a definition.
- **Value-free.** No output or finding contains the secret, only the field path
  and the suggested vault name and key.

## Best-effort residual

The scan resolves each definition's type schema through the model registry to
find sensitive global args. If a type cannot be resolved (e.g. an extension not
installed locally), the definition is reported as **unresolved**: an advisory
warning, not a silent skip.

## Nested fields

The rule walks the schema and the stored values together
(`findValuesWithMetadata` in `src/domain/models/zod_field_metadata.ts`), so a
sensitive field is found wherever it is nested: in objects, array elements,
tuple items, record values, union members and intersections. A finding names the
element: `users[1].password`, `accounts.prod.token`.

- **Unions.** No member's validation runs. Every member the value could belong
  to is checked: members of the wrong container kind are dropped, and a
  discriminated union is narrowed by its discriminator when the value carries a
  literal one. A value is refused if any remaining member marks it sensitive.
- **Vault keys.** A field inside an array element or record value occurs once
  per element, so its suggested vault key is built from the whole path
  (`users-1-password`). A declared `vaultKey` is not used there, because every
  element would share it. A declared `vaultName` still applies. A field reached
  only through objects, unions or wrappers occurs once and keeps its declared
  `vaultKey`.
- **Paths.** A path names one place in the stored value. A key made of
  letters, digits, `_` and `-` is joined with a dot. Any other key is written
  quoted and escaped (`accounts["eu.west"].token`), so it cannot read as nesting
  or as an array index, and a control character in a key is not printed raw. A
  path naming an array element is not a `--global-arg` key; the refusal says to
  pass the whole array with `<name>:json=[...]`. Suggested vault keys that come
  out the same get a numeric suffix.

The redaction and vaulting primitives in the same module
(`redactSensitiveValues`, `extractSensitiveFieldValues`, resource-data vaulting)
read the schema alone and still see object-nested fields only (swamp-club#3038).

## Out of scope

Only model definitions are scanned. Guarding datastore sync at write time
and covering workflow-definition global arguments are deliberately excluded.
