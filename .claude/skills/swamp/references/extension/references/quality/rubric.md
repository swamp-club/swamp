# Swamp Club scorecard rubric — complete reference

Rubric v6: 12 factors, 16 points. The rubric lives in the
`@swamp-club/extension-scoring` package, which `swamp extension quality`,
`swamp extension push` and the Swamp Club registry all score with, so the CLI
and the registry apply the same rules.

## Contents

- [Score and grade](#score-and-grade)
- [Statuses](#statuses)
- [Per-factor reference](#per-factor-reference)
- [The `deno doc` run](#the-deno-doc-run)
- [Worked example](#worked-example)

## Score and grade

`percentage = floor(earned × 100 / 16)`, and the grade comes from the
percentage. `swamp extension quality` and the registry use the same formula, so
the local percentage and grade are the registry's for the points already
confirmed.

Before publish, `swamp extension quality` cannot confirm a public repository.
When the registry is expected to verify one, `repository-verified`'s 2 points
are provisional: not earned yet, reported in `provisionalPoints`, and still in
the divisor. The text output names what they would raise the score to, e.g.
`14/16 points (87%, grade B, +2 pending server verification: 100% (A) if the registry verifies them, ...)`.
In `--json`, `percentage` and `grade` count confirmed points only, and
`ifProvisionalEarned` (right after `grade`) gives the registry's
`{percentage, grade}` once it verifies the repository, or `null` when nothing is
pending.

| Grade | Range |
| ----- | ----- |
| A     | ≥ 90% |
| B     | ≥ 75% |
| C     | ≥ 60% |
| D     | ≥ 40% |
| F     | < 40% |

The verified-by-swamp badge (first-party `@swamp` or admin-curated) is not a
factor and never moves the percentage.

## Statuses

| Status        | Meaning                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------- |
| `earned`      | All points                                                                                    |
| `partial`     | Some points (`dependency-trust` at 1/2)                                                       |
| `missing`     | No points; the row carries a `remediation`                                                    |
| `provisional` | Before publish, a factor only the registry awards and is expected to; no points until it does |
| `pending`     | Registry only: the version has not been analysed yet                                          |

## Per-factor reference

Rows appear in this order.

### `has-readme` (2 pts) — "Has README or module doc"

Earned when the archive has a README, or every entrypoint has a module-level
JSDoc. The README is looked up at `<root>/` then `<root>/files/` (where
`additionalFiles:` land) as `README.md`, `README.MD`, `readme.md` or
`Readme.md`, matched exactly against the directory listing on every platform:
`ReadMe.md` does not count, even on macOS or Windows. Nested entries such as
`additionalFiles: [docs/README.md]` land at `files/docs/README.md` and earn
nothing; use a bare basename or `paths.base: manifest`. A module JSDoc counts
only once `deno doc` can analyse the source.

### `readme-example` (1 pt)

Earned when the README has a fenced code block: `` ```[lang]\n…\n``` ``.

### `rich-readme` (1 pt) — "README is substantive"

Earned when the README is ≥ 500 characters **and** has ≥ 2 fenced code blocks.
No README scores `missing`.

### `symbols-docs` (1 pt) — "Most symbols documented"

Earned when ≥ 80% of exported declarations across the entrypoints have a
non-empty JSDoc (`deno doc --json`; each overload counts). Zero exports is 100%.
When `deno doc` cannot analyse the source, nothing counts as documented and
`docAnalysisError` names the failure; fix that first.

### `fast-check` (1 pt, deprecated)

Always earned on an analysed version.

### `dependency-trust` (2 pts) — "Dependencies pass trust audit"

Every `npm:` and `jsr:` import in every non-test code module of the archive is
audited at the version that ships. Push writes every such import exact, at the
version its bundle holds, and lists each in `dependency-audit.json`; the
registry audits only an exact import that record lists, never resolving a range
or reading a lock. An archive pushed before that form keeps the earlier order:
an exact pin, the record, the lock, then the registry's resolution. Imports are
read from the module's syntax tree: a commented-out import or a specifier-shaped
string is not a dependency. At most 50 dependencies are looked up; the rest are
not audited.

- **2 points**: no blocker and nothing unaudited; every version was written
  exact or fixed by a valid lock (`deno.lock`, or a `package-lock.json` that
  node_modules matches).
- **1 point (`partial`)**: only loose specifiers: a range, dist-tag or unpinned
  import that no valid lock fixed (`loose-specifier`), however many.
- **0 points**: any blocker or unaudited dependency.

Blockers: a HIGH, CRITICAL or UNKNOWN OSV vulnerability (a grade OSV does not
define reads as UNKNOWN); a deprecated package; a deprecated shipped version
(`deprecated-version`); a missing or invalid JSR package or version, including
an unscoped `jsr:name` (`jsr-missing`); a yanked JSR version (`jsr-yanked`).
Push blocks on the first and fourth kinds and only warns on the deprecated and
yanked versions (`--yes` waives them), but the score counts all of them.

Not audited (`cause: "not-audited"`, `notAuditedFix` says why):

| `notAuditedFix` | Why                                                                                                                                             | Fix                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `outage`        | an OSV, npm or JSR lookup failed, or OSV answered malformed                                                                                     | re-run                                      |
| `specifier`     | npm does not list the version, or no published version matches                                                                                  | change the specifier                        |
| `name`          | an invalid npm package name                                                                                                                     | correct the name                            |
| `origin`        | code from outside npm and JSR: a URL import, a git dependency, or a local (`file:`, `link:`, path) package.json dependency; named by its origin | replace it with an `npm:` or `jsr:` package |
| `canonical`     | registry only: an archive whose source breaks the exact form push writes (hand-edited)                                                          | push again with `swamp extension push`      |
| `other`         | more than 50 dependencies                                                                                                                       | —                                           |

A module that does not parse is not audited either, under its path. Code from
outside npm and JSR still bundles and publishes; it only costs the points.

Warnings that cost nothing: MEDIUM vulnerabilities, a license that is not an
SPDX expression of allowlisted licenses (MIT, Apache-2.0, BSD-2-Clause,
BSD-3-Clause, ISC, 0BSD, MPL-2.0, Unlicense, CC0-1.0) or no license, an empty
maintainers list, under 1,000 weekly downloads, last publish over 24 months ago.

### `secret-safe-docs` (1 pt) — "Docs keep secrets in a vault"

Earned when no `secret-unsafe-docs` finding is left unaccepted and every
documentation file was read. Checked:

- every `.md` in the archive except `binaries:` and `include:` entries and
  Markdown a code module imports (data, not docs);
- the `.describe(...)` and `description:` strings of every non-test `.ts`
  module, including include files and code outside the kind directories;
- the manifest's parsed `description` (a YAML comment is not documentation);
  findings sit on the `description:` line, so accepting that line accepts them
  all.

A file over 1 MiB, or more than 10,000 files, is not read; the factor then fails
and no acceptance covers it. Flagged forms: vault syntax swamp does not resolve
(`vault://`, `<vault:`, `{{ vault …}}`, `swamp vault set`); `--global-arg` or
`--input` setting a secret argument (sensitive in a schema — `extensions:`
methods included — or, undeclared, named like a token, key, secret or password)
to anything but `${{ … }}`; `swamp vault put` with the value on the command line
(unless `--server` or a shell variable); full-length credential shapes. In
Markdown, all but credential shapes count only inside fenced code blocks.

### `description` (1 pt)

Earned when `description:` is non-empty after trimming whitespace.

### `platforms` (2 pts) — "Platform support declared (or universal)"

Always earned: any list, or none (universal).

### `has-license` (1 pt) — "License declared"

Earned when `license:` is a valid SPDX expression of current ids (`MIT`,
`MIT OR Apache-2.0`, `Apache-2.0 WITH LLVM-exception`). `LicenseRef-`,
deprecated ids and lowercase operators earn nothing.

### `license-file` (1 pt) — "LICENSE file included"

Earned by a non-empty file at `<root>/` or `<root>/files/` named exactly one of
`LICENSE`, `LICENSE.md`, `LICENSE.txt`, `LICENSE.MD`, `LICENSE.TXT`, `License`,
`License.md`, `License.txt`, `license`, `license.md`, `license.txt`, `COPYING`,
`COPYING.md`, `COPYING.txt`.

### `repository-verified` (2 pts) — "Verified public repository"

The registry awards it when `repository:` is a public HTTPS repository on
github.com, gitlab.com, codeberg.org or bitbucket.org that the host's API
confirms, or when the extension is private and its collective has private source
hosting ("Private repository (collective attested)"). Before publish,
`swamp extension quality` marks it `earned` when it predicts a private publish
from a collective with private source hosting, since the registry awards that on
the attestation alone; `provisional` when the URL names an owner and a
repository on one of those hosts; otherwise `missing`, with a remediation that
says whether private source hosting could be checked.

## The `deno doc` run

The scorer strips `deno.json`, `deno.jsonc`, `deno.lock`, `package.json`,
`package-lock.json`, `.npmrc` and `node_modules` from the manifest root, writes
`{"nodeModulesDir": "auto"}`, and runs `deno doc --json` and `deno doc --lint`
with `--allow-import` limited to deno.land, jsr.io, esm.sh, raw.esm.sh,
cdn.jsdelivr.net, raw.githubusercontent.com, gist.githubusercontent.com and
registry.npmjs.org. Each manifest entrypoint is analysed at `<field>/<entry>`,
so `models: [models/foo.ts]` is read at `models/models/foo.ts`, where push
archives it.

By default `swamp extension quality` reuses swamp's Deno cache and the user's
environment. `--isolated` runs as the registry does: an empty cache and no
registry tokens, npm config or other inherited variables. Use it when a private
import or a warm cache could make the local score differ from the registry's.

## Worked example

```yaml
manifestVersion: 1
name: "@mycollective/my-extension"
version: "2026.10.26.1"
license: MIT
description: "One-sentence explanation of what this extension does."
repository: https://github.com/mycollective/my-extension
additionalFiles:
  - README.md
  - LICENSE
behaviors:
  - my-behavior.ts
```

| Factor              | Points | Why                                            |
| ------------------- | ------ | ---------------------------------------------- |
| has-readme          | 2/2    | README.md in additionalFiles                   |
| readme-example      | 1/1    | Usage code block                               |
| rich-readme         | 1/1    | 1.2k characters, 3 code blocks                 |
| symbols-docs        | 1/1    | All exports documented                         |
| fast-check          | 1/1    | Deprecated; always earned                      |
| dependency-trust    | 2/2    | Pinned or locked, nothing blocked or unaudited |
| secret-safe-docs    | 1/1    | No unaccepted findings                         |
| description         | 1/1    | Non-empty                                      |
| platforms           | 2/2    | Universal                                      |
| has-license         | 1/1    | `license: MIT`                                 |
| license-file        | 1/1    | LICENSE in additionalFiles                     |
| repository-verified | 2/2    | Public github.com repository                   |

Registry: 16/16 = 100% (A). Before publish, `swamp extension quality` shows
14/16 = 87% (B) with 2 points pending server verification, and 100% (A) if the
registry verifies them.
