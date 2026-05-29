# Doctor Secrets — cleartext sensitive-argument scan

`swamp doctor secrets` is a read-only diagnostic that reports model
definitions whose `sensitive: true` global arguments hold a **cleartext
literal** value instead of a `vault.get(...)` expression. It emits per-finding
remediation guidance in both log and JSON output modes and exits non-zero when
any leak is found, so CI can gate on it.

## Why it exists

swamp-club#480 (PR #1469) added a guard at the single persistence chokepoint —
`YamlDefinitionRepository.save()` — that refuses to write a literal value for a
sensitive global argument. That guard only protects **new** writes. Two gaps
remain that a write-time guard cannot close:

1. **Legacy definitions** authored before the guard still hold the secret in
   cleartext until they are re-saved.
2. **Datastore sync / migration** copies definition YAML byte-for-byte, so a
   cleartext literal authored on an older swamp or another machine can land on
   disk without passing through `save()`.

`doctor secrets` is the detection half: it scans what is already on disk and
points the user at the fix. It does **not** remediate automatically — it
reports, and the user migrates the secret to a vault and re-saves.

## What it scans

It enumerates two definition trees:

- The source-of-truth definitions under `models/`. These are the
  datastore-synced files — a literal authored elsewhere lands here after a
  pull, so scanning the working tree covers synced/pulled definitions.
- The locally auto-created definitions under `.swamp/auto-definitions`.

The public `findAllGlobal()` only walks its own `baseDir`, so the deps point a
second repository at the auto-definitions tree and concatenate the results.

## The rule it applies

Detection reuses the **same** pure domain rule the write-time guard enforces:
`findLiteralSensitiveGlobalArgs` in
`src/domain/models/sensitive_field_extractor.ts`. What the scan surfaces is
therefore exactly what a re-save would now refuse. Remediation guidance is
built by `buildSensitiveArgRemediations`, the structured sibling of the guard's
`literalSensitiveGlobalArgsMessage`: both point at the same fix (store the
secret in a vault, reference it with `vault.get(...)`), but the scan returns
per-path vault coordinates a renderer can print as concrete commands.

## Read-only and value-free

- **Read-only.** The scan never calls `save()`, so it never trips the at-rest
  guard and never mutates a definition.
- **Value-free.** Neither output mode — nor the structured finding payload —
  ever carries the cleartext secret. Findings and remediation guidance contain
  only the field path and the suggested vault name/key.

## Best-effort residual

Detection depends on resolving each definition's type schema through the model
registry to know which global args are sensitive. When a type cannot be
resolved (e.g. an extension that is not installed locally), the definition is
reported as **unresolved** — an advisory warning rather than a silent skip — so
the scan never implies it vouched for a definition it could not assess. This
mirrors the object-shape-only limitation of the redaction primitives in the
same module.

## Out of scope

This scan covers **model** definitions. Guarding datastore sync at write time,
and covering workflow-definition global arguments, are deliberately not part of
this command.
