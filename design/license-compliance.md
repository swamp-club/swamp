# License Compliance

Swamp generates a [CycloneDX](https://cyclonedx.org/) Software Bill of Materials
(SBOM) describing every third-party dependency it ships, with an SPDX license
for each. The SBOM is the input to license-compliance scanning — verifying that
the licenses of bundled dependencies are compatible with how swamp is
distributed.

The generator lives in `scripts/generate_sbom.ts` and runs via `deno run sbom`.

## Why a custom generator

Swamp is a Deno project: its dependency graph spans both npm and JSR packages,
recorded in `deno.json`/`deno.lock`. Off-the-shelf SBOM and SCA tools (FOSSA,
Trivy, Syft) have no native Deno analyzer — pointed at the repo they discover
nothing, or only an unrelated npm sub-project. The authoritative graph comes
from `deno info --json main.ts`, so the generator reads that and emits a
standard CycloneDX document any tool can consume.

## SBOM generation

```bash
deno run sbom                 # write sbom.cdx.json (the default)
deno run sbom --output -      # write to stdout instead
deno run sbom --offline       # use cached license data only, no network
```

Discovery uses `deno info --json main.ts` — the resolved graph of npm packages
(with their local cache paths) and every jsr.io module specifier. The output is
CycloneDX 1.6 JSON, sorted deterministically, with one `library` component per
dependency plus the dependency relationship graph.

`sbom.cdx.json` is git-ignored (it is a build artifact). The JSR license cache
(`scripts/jsr_license_cache.json`) **is** committed, so CI and offline runs are
deterministic.

## License resolution

A license is resolved for every component:

- **npm** — read from the package's cached `package.json` (`license`, the
  deprecated `licenses` array, or an object form), entirely offline. Falls back
  to the npm registry if a package isn't cached locally.
- **JSR** — fetched from the JSR per-version API
  (`api.jsr.io/scopes/{scope}/packages/{name}/versions/{version}`) and persisted
  to `scripts/jsr_license_cache.json`. Repeat runs and CI read from the cache and
  never hit the network for already-seen versions. `@std/*` packages that
  declare no license resolve to MIT (the Deno standard library license).

A component with no resolvable license is emitted as `NOASSERTION`, and the
generator exits non-zero — a built-in signal that a dependency needs manual
review.

## CycloneDX required fields

The SBOM populates the fields downstream tools (e.g. FOSSA's required-field
check) expect for every component:

- **Supplier** — npm packages use the `author` name; JSR packages use the scope
  (e.g. `@std`).
- **PURL** — `pkg:npm/...` for npm and `pkg:jsr/@scope/name@version` for JSR.
- **Relationship data** — every component has a `dependsOn` entry (leaves carry
  an explicit empty list); npm and jsr→jsr edges are included.
- **BOM author** and **creation timestamp** are set in `metadata`.

## Scanning with FOSSA

[FOSSA](https://fossa.com/) ingests the CycloneDX SBOM directly. Set
`FOSSA_API_KEY`, then:

```bash
deno run sbom                       # regenerate the SBOM
fossa sbom analyze sbom.cdx.json    # upload and analyze
fossa sbom test sbom.cdx.json       # check for license-policy violations
```

`fossa sbom test` exits non-zero when the analyzed SBOM violates the
organization's license policy. A push-only `FOSSA_API_KEY` can upload and
trigger scans but cannot read issue details back — use a full-access key, or
view the report in the FOSSA web app, to inspect violations.

## Related

- [audit.md](audit.md) — the separate OSV-based vulnerability audit
  (`deno run audit`), which scans the same dependency set for known CVEs.
