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
warning, not a silent skip. The redaction primitives in the same module have the
same object-shape-only limit.

## Out of scope

Only model definitions are scanned. Guarding datastore sync at write time
and covering workflow-definition global arguments are deliberately excluded.
