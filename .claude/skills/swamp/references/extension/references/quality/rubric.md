# Swamp Club scorecard rubric — complete reference

The rubric evaluates an extension against 12 factors, totaling 15 points. The
displayed percentage is `floor(earned * 100 / 15)`. The letter grade is derived
from the percentage.

## Grade thresholds

| Grade | Range |
| ----- | ----- |
| A     | ≥ 90% |
| B     | ≥ 75% |
| C     | ≥ 60% |
| D     | ≥ 40% |
| F     | < 40% |

## Score ceilings

| Extension type                  | Ceiling      | Why                                                    |
| ------------------------------- | ------------ | ------------------------------------------------------ |
| Third-party, all factors earned | 15/16 = 93%  | `verified-by-swamp` is unearnable without admin review |
| First-party (`@swamp/*`)        | 16/16 = 100% | First-party namespace auto-earns `verified-by-swamp`   |
| Admin-curated third-party       | 16/16 = 100% | Admin review endpoint earns the factor                 |

## Per-factor reference

### `has-readme` (2 pts)

Earned when the tarball contains a README file. The analyzer looks at:

1. `<logical root>/README.md` (and `.MD`, and `readme.md`)
2. `<logical root>/files/README.md` (same case variants)

The second location is where files listed in `manifest.yaml`'s
`additionalFiles:` field land. Both lookups are exact at this level — the
analyzer does NOT recurse, so a nested entry like
`additionalFiles: [docs/README.md]` lands at `<root>/files/docs/README.md` and
earns zero. Use a bare basename and, if your source layout requires it, opt into
`paths.base: manifest`.

### `readme-example` (1 pt)

Earned when the README contains at least one fenced code block. Detection is
regex-based:

````
^```[word characters or -]*\s*\n[any content]\n```
````

Any language tag (or no language tag) counts.

### `rich-readme` (1 pt)

Earned when **both** conditions hold:

- README length ≥ 500 characters (raw byte count of the decoded file)
- README contains ≥ 2 fenced code blocks (same regex as above)

A README that is 499 characters or has exactly one code block earns 0 for this
factor. It is deliberately cheap to clear; any substantive README satisfies it.

### `symbols-docs` (1 pt)

Earned when at least 80% of exported symbols across the declared entrypoints
have a JSDoc comment. Computed via `deno doc --json`:
`documentedExports / totalExports ≥ 0.80`.

Counting rules:

- Only exported symbols count.
- Each symbol is counted once per declaration (function overloads count as
  separate declarations).
- A symbol is "documented" if its `jsDoc.doc` field is a non-empty string.
- Types, interfaces, classes, functions, and constants all count.

### `fast-check` (1 pt)

Earned when `deno doc --lint <entrypoints>` produces zero slow-type diagnostics.
Slow-type diagnostic codes include:

- `missing-return-type`
- `missing-explicit-type`
- `private-type-ref`
- `unsupported-ambient-module`
- `unsupported-complex-reference`
- `unsupported-default-export-expr`
- `unsupported-destructuring`
- `unsupported-global-module`
- `unsupported-require`
- `unsupported-ts-export-assignment`
- `unsupported-ts-instantiation-expression`
- `unsupported-ts-namespace-export`
- `unsupported-using-stmt`

A single diagnostic of any of these codes costs the whole point.

### `description` (1 pt)

Earned when the `description` field on the extension record is a non-empty
string. The CLI populates this from `manifest.yaml`'s `description:` field
during push. Owners can also edit it post-publish via the Swamp Club owner
panel.

### `platforms-one` (1 pt)

Earned when **either**:

- `platforms:` has at least one entry, OR
- `platforms:` is empty (an empty array is treated as "supports all platforms",
  which is strictly more permissive than any explicit list)

### `platforms-two` (1 pt)

Same rule, but the array must have ≥ 2 entries (or be empty).

An array of exactly one platform fails this factor because it is a more
restrictive declaration than "universal". This is intentional — an author who
has tested on multiple platforms is more trusted than one who has tested on
exactly one.

### `has-license` (1 pt) — "License declared"

Earned when the manifest's `license:` is a valid SPDX license expression, such
as `MIT`, `Apache-2.0` or `MIT OR Apache-2.0`. The license is optional: leaving
it out, or declaring a value that is not valid SPDX, only costs this point. Only
SPDX identifiers count — a `LicenseRef-` or `AdditionRef-` earns nothing, and
`swamp extension quality` and `push` print a warning for an invalid value. A
LICENSE file does not earn this factor; it earns `license-file`.

### `license-file` (1 pt) — "LICENSE file included"

Earned when the tarball contains a non-empty license file at `<root>/*` or
`<root>/files/*`.

The lookup is exact at this level — the analyzer does NOT recurse, so a nested
entry like `additionalFiles: [legal/LICENSE]` lands at
`<root>/files/legal/LICENSE` and earns zero. Use a bare basename and, if your
source layout requires it, opt into `paths.base: manifest`.

Recognized license filenames (case-sensitive matches). `LICENSE` variants are
preferred; `COPYING` variants are also accepted:

```
LICENSE, LICENSE.md, LICENSE.txt, LICENSE.MD, LICENSE.TXT,
License, License.md, License.txt,
license, license.md, license.txt,
COPYING, COPYING.md, COPYING.txt
```

### `repository-verified` (2 pts)

Earned on the server in one of two ways: the `repository:` URL points to a
public repository on an allowlisted host, confirmed via that host's public API;
or the extension is private and Swamp Club has marked its collective for private
source hosting (any URL, or none).

Allowlisted hosts and the API endpoints used:

| Host            | API endpoint                                                      |
| --------------- | ----------------------------------------------------------------- |
| `github.com`    | `GET https://api.github.com/repos/:owner/:repo`                   |
| `gitlab.com`    | `GET https://gitlab.com/api/v4/projects/:encoded-path`            |
| `codeberg.org`  | `GET https://codeberg.org/api/v1/repos/:owner/:repo`              |
| `bitbucket.org` | `GET https://api.bitbucket.org/2.0/repositories/:workspace/:repo` |

The URL is parsed to extract owner/repo (nested group paths supported for
GitLab). A 200 response with the repo reporting itself public earns the factor.
404, private, rate-limited, or any network error means not verified.

Self-hosted Git (GitHub Enterprise, self-hosted GitLab, Gitea, Forgejo, Azure
DevOps, Bitbucket Server) and private repositories cannot pass the public check.
A **private** extension from one earns the factor when its collective has
private source hosting; the scorecard then reads "Private repository (collective
attested)". A public extension needs a verified public repository.

`swamp extension quality` reaches the same verdict before publish. It reads the
collective's private source hosting from Swamp Club's whoami response and
predicts the extension's visibility the way the registry sets it: a republish
keeps the published visibility; a first publish is private when the manifest
says `visibility: private` or the collective's namespace is private. When that
applies, the factor is **provisional** with the collective-attested label.
Otherwise an allowlisted HTTPS URL is provisional and anything else is
**missing**. If quality cannot get an answer (not logged in, key rejected, Swamp
Club unreachable, or nothing reported for the collective), it scores the URL
alone and the remediation says private source hosting could not be checked.

A verified result is cached for 7 days on the extension record, an unverified
one for an hour. URL changes clear the cache and trigger re-verification.

### `dependency-trust` (2 pts)

Earned when all dependencies pass the supply-chain trust gates. The CLI extracts
`npm:` and `jsr:` import specifiers from extension source files and audits each
at the version the push ships (exact pin, else the honoured `deno.lock`, else
the registry's resolution) against OSV.dev advisories, the npm registry and
jsr.io.

**Blockers (prevent push and fail the factor):**

- HIGH or CRITICAL severity vulnerabilities (from OSV.dev)
- Deprecated packages (the shipped version and latest both deprecated)
- A JSR package or version that does not exist (`cause: "jsr-missing"`)

**Pinned deprecated version (fails the factor, does not block yet):** a shipped
npm version that is deprecated while the package's latest is not
(`cause: "deprecated-version"`) is a push warning, waived by `--yes`, but it
loses the factor, as on the registry scorecard. Pin a supported version.

**Not audited (fails the factor, does not block):** a dependency whose OSV.dev,
npm or JSR lookup failed, or whose specifier no published version matches, is
reported as not audited (`cause: "not-audited"` with a `reason`) and never as
passed. Re-run when all three services are reachable to earn the factor.

**Warnings (displayed but do not block or cost the factor):**

- An unpinned, range or dist-tag specifier (`loose-specifier`)
- A yanked JSR version (`jsr-yanked`)
- MEDIUM severity vulnerabilities
- Low weekly downloads (< 1000)
- Stale last-publish (> 2 years)
- Non-OSI-approved license
- Single maintainer

JSR has no vulnerability data on OSV, so a `jsr:` import is checked for
existence and yanking only.

If the dependency audit does not run (e.g. cached push without re-audit), the
factor defaults to `missing` — no free points.

### `verified-by-swamp` (1 pt)

Earned in one of two ways:

1. The extension is published under the `@swamp` namespace (the first-party
   collective), OR
2. A Swamp Club admin has explicitly marked the extension verified via a
   curation endpoint (not yet built)

Third-party authors should not try to earn this factor. It is the deliberate gap
between 93% and 100%.

## Factors in the codebase but not currently rendered

### `provenance` (1 pt, gated)

Earned when the extension was published from GitHub Actions with a
Sigstore-signed bundle verified by the server. Currently gated behind a feature
flag (`PROVENANCE_IN_RUBRIC = false`) because CLI-side signing support has not
shipped. When the CLI lands provenance support and the flag flips, the rubric
divisor becomes 16 and extensions published from CI earn an additional point.

## Worked example: a third-party extension that earns 93%

Manifest:

```yaml
manifestVersion: 1
name: "@mycollective/my-extension"
version: "2026.04.22.1"
license: MIT
description: "One-sentence explanation of what this extension does."

repository: https://github.com/mycollective/my-extension

additionalFiles:
  - README.md
  - LICENSE

behaviors:
  - my-behavior.ts

platforms:
  - linux-x86_64
  - darwin-aarch64
```

Factor results:

| Factor              | Earned | Reason                                       |
| ------------------- | ------ | -------------------------------------------- |
| has-readme          | 2/2    | README.md listed in additionalFiles          |
| readme-example      | 1/1    | README contains a usage code block           |
| rich-readme         | 1/1    | README is 1.2k chars with 3 code blocks      |
| symbols-docs        | 1/1    | All 8 exports documented (100%)              |
| fast-check          | 1/1    | Explicit return types, no private-type leaks |
| description         | 1/1    | Non-empty                                    |
| platforms-one       | 1/1    | 2 platforms listed                           |
| platforms-two       | 1/1    | 2 platforms listed                           |
| has-license         | 1/1    | `license: MIT` declared                      |
| license-file        | 1/1    | LICENSE file in additionalFiles              |
| repository-verified | 2/2    | Public github.com URL                        |
| dependency-trust    | 2/2    | No blocking or unaudited dependencies        |
| verified-by-swamp   | 0/1    | Third-party, not admin-curated               |

**Total: 15/16 = 93% Grade A.**

## Ceiling with future provenance

Once `PROVENANCE_IN_RUBRIC` is enabled:

| State                          | Divisor | Third-party ceiling |
| ------------------------------ | ------- | ------------------- |
| Flags off (current)            | 16      | 15/16 = 93%         |
| Provenance on, publish from CI | 17      | 16/17 = 94%         |
| Provenance on, no CI publish   | 17      | 15/17 = 88%         |

When the flag flips, extensions not publishing from CI will see a 6% regression.
Authors who want to stay at 93% will need to switch to publishing via GitHub
Actions at that point.
