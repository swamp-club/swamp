# @swamp-club/extension-scoring

How Swamp Club scores an extension: the quality rubric and every rule it rests
on. The swamp CLI (`swamp extension quality` and `swamp extension push`) and the
Swamp Club registry's scorecard both score with this package, so an archive gets
the same score on both sides.

| Entry point          | What it decides                                                        |
| -------------------- | ---------------------------------------------------------------------- |
| `./rubric`           | The factor table, the per-version analysis and the composed score      |
| `./archive`          | Which archive files count, where the manifest is, how `deno doc` runs  |
| `./licensing`        | SPDX expressions and the manifest license policy                       |
| `./secret-docs`      | Documentation that handles a secret in plaintext, and which files      |
| `./dependency-audit` | The `npm:` and `jsr:` dependency trust audit and its 2/1/0 points      |
| `./doc-failure`      | Why `deno doc` could not analyse a source, in one sentence             |
| `./source`           | Parsing extension source, and the import specifiers a module writes    |
| `./vectors/*.json`   | Shared test vectors: every consumer runs them and must get the results |

The package does no I/O and uses no runtime APIs. The caller extracts the
archive, lists and reads its files, runs `deno doc`, and fetches from npm, OSV
and JSR; the package decides what those answers mean. It parses extension source
with `@babel/parser`, one configuration for every reader, so a module reads the
same to the CLI and the registry; its other dependencies are `@std/semver` and
`@std/path`.

## Use from Deno

```ts
import {
  composeScore,
  RUBRIC_VERSION,
} from "jsr:@swamp-club/extension-scoring/rubric";
```

## Use from Node or Bun

JSR publishes the package for npm clients as JavaScript with type declarations:

```sh
npx jsr add @swamp-club/extension-scoring
bunx jsr add @swamp-club/extension-scoring
```

```ts
import { composeScore } from "@swamp-club/extension-scoring/rubric";
```

## Vectors

Each file under `vectors/` pairs inputs with the results the package must give.
A consumer that wraps the package — fetching for the dependency audit, listing
an archive for the secret-docs check — runs the same vectors through its own
wrapper:

```ts
import vectors from "jsr:@swamp-club/extension-scoring/vectors/rubric.json" with {
  type: "json",
};
```

## Dependency audit record

Push writes `dependency-audit.json` beside `manifest.yaml`. Since
swamp-club#3970 it is `recordVersion: 2`: the archive's source names every
`npm:` and `jsr:` import at one exact version (the canonical shipped form,
checked by `canonicalShippedSpecifierIssue`), and the record lists each shipped
package version with how it was chosen (`from`, `locked`, `writtenAs`), a
SHA-256 of each bundle, and the code from outside npm and JSR the bundles hold
(`unaudited`). `buildDependencyAuditRecordV2`,
`serializeDependencyAuditRecordV2` and `parseDependencyAuditRecordV2` write and
read it; `parseDependencyAuditRecord` still reads archives pushed with
`recordVersion: 1` and reads a v2 record as no record. The `recordV2` and
`canonical` sections of `vectors/dependency_audit.json` pin both.

A non-exact specifier (range, dist-tag, unpinned) costs the dependency factor's
loose point only when no valid lock fixed its version: pinning exact versions
and committing a lock score the same.

To score a v2 archive, pass `canonicalRecordedVersions(record)` as the `record`
argument of `planNpmPackage` and `evaluateJsrPackage`: only an exact specifier
the record lists resolves, with no lock read and no range resolution, and
anything else is not audited (`notAuditedFix: "canonical"`). Pass the record's
`unaudited` list as `scorecardResult`'s third argument; push and quality add the
same code with `withUnauditedCode`. Each entry is not audited under its origin
(`notAuditedFix: "origin"`) and costs both points. The `canonicalScoring` and
`unauditedCode` sections of the vectors pin both.

## Versions

Published from `packages/extension-scoring` in the swamp repository on every
merge that changes it, as `0.YYYYMMDD.N`. A change that can move a score bumps
`RUBRIC_VERSION`, so a stored score says which rules made it.
