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
| `./source`           | Reading import specifiers from source without parsing it               |
| `./vectors/*.json`   | Shared test vectors: every consumer runs them and must get the results |

The package does no I/O and uses no runtime APIs. The caller extracts the
archive, lists and reads its files, runs `deno doc`, and fetches from npm, OSV
and JSR; the package decides what those answers mean. Its only dependency is
`@std/semver`.

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

## Versions

Published from `packages/extension-scoring` in the swamp repository on every
merge that changes it, as `0.YYYYMMDD.N`. A change that can move a score bumps
`RUBRIC_VERSION`, so a stored score says which rules made it.
