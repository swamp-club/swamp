---
name: swamp-extension-quality
description: >
  Guide extension authors to hit the Swamp Club quality scorecard — raise
  an extension's score (percentage + letter grade) by following the 11-factor
  rubric covering README, LICENSE, JSDoc coverage, type safety, manifest
  completeness, and repository verification. Use when authoring or reviewing
  a swamp extension for quality, preparing for a good score, troubleshooting
  a low score, or understanding what each factor measures. Do NOT use for
  implementing a specific extension type (that is swamp-extension-model,
  -driver, -vault, or -datastore), for publishing mechanics (that is
  swamp-extension-publish), or for runtime debugging (that is
  swamp-troubleshooting). Triggers on "quality score", "scorecard",
  "improve my extension", "extension quality", "factor breakdown", "why
  is my score low", "Grade A extension", "quality checklist", "what makes
  a good extension", "scorecard factors", "rubric", "extension best
  practices", "swamp club score".
---

# Swamp Extension Quality

Swamp Club scores every published extension against a rubric that rewards
documentation, type safety, and supply-chain signals. Use this skill to shape an
extension so it earns the maximum score a third-party extension can reach:
**12/13 = 92% (Grade A)**. The remaining 8% is reserved for first-party
(`@swamp`) or admin-curated extensions and is not earnable through authoring.

## Scope boundaries — when this skill fires vs. when another one does

| Task                                   | Skill                                                                                                      |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Authoring for a high scorecard         | `swamp-extension-quality` (this one)                                                                       |
| Implementing a specific extension type | `swamp-extension-model` / `swamp-extension-driver` / `swamp-extension-vault` / `swamp-extension-datastore` |
| Mechanics of pushing to the registry   | `swamp-extension-publish`                                                                                  |
| Debugging an error or failure          | `swamp-troubleshooting`                                                                                    |

This skill does **not** duplicate content from those. It only adds the quality
signals layered on top of whatever the type-specific skill produced.

## The factor-to-action map (memorise this)

| Factor                | Pts | Earn it by                                                                                         |
| --------------------- | --- | -------------------------------------------------------------------------------------------------- |
| `has-readme`          | 2   | List `README.md` under `additionalFiles:` in `manifest.yaml`                                       |
| `readme-example`      | 1   | Include ≥1 fenced code block in the README                                                         |
| `rich-readme`         | 1   | Make the README ≥500 characters AND have ≥2 fenced code blocks                                     |
| `symbols-docs`        | 1   | JSDoc ≥80% of exported symbols across all entrypoints                                              |
| `fast-check`          | 1   | Explicit return types on every export; no private-type references in public exports                |
| `description`         | 1   | Fill `description:` in `manifest.yaml` with a non-empty string (not "TODO")                        |
| `platforms-one`       | 1   | Set `platforms:` to a non-empty list OR leave empty (empty = "universal")                          |
| `platforms-two`       | 1   | Set `platforms:` to ≥2 entries OR leave empty                                                      |
| `has-license`         | 1   | Add a LICENSE file (`LICENSE`, `LICENSE.md`, `LICENSE.txt`, or `COPYING`) under `additionalFiles:` |
| `repository-verified` | 2   | Set `repository:` to a public HTTPS URL on github.com, gitlab.com, codeberg.org, or bitbucket.org  |
| `verified-by-swamp`   | 1   | Only earnable by the `@swamp` namespace or admin review — do not try to game it                    |

`verified-by-swamp` is the one third-party authors cannot earn; everything above
it is fair game.

## Essential mechanics authors get wrong

**Files listed in `additionalFiles:` end up under `extension/files/` in the
tarball**, not at the extension root. The analyzer checks both locations for
README and LICENSE, so either works, but this trips up authors who assume the
root is the only path. If a README is in the repo root but not in
`additionalFiles:`, **it is not in the tarball at all** and earns zero.

**`repository:` must be on one of the allowlisted hosts** — github.com,
gitlab.com (public SaaS only), codeberg.org, bitbucket.org. Self-hosted GitHub
Enterprise, self-hosted GitLab, private Gitea, Azure DevOps, Bitbucket Server —
none earn the 2-point verification factor. URL must be HTTPS.

**Bare-specifier imports fail `swamp extension quality`.** The command runs
hermetically — it strips the tarball's `deno.json`, so a bare `"zod"` import
cannot resolve and the command throws
`deno doc --json failed: Import "zod" not a dependency` **before** factor
scoring begins. Fix: use `import { z } from "npm:zod@4"` in every entrypoint
file. Adding `deno.json` to `additionalFiles:` does not help — it lands at
`files/deno.json`, which the scorer does not promote. **Deno's default lint
rules enable `no-import-prefix` whenever an `imports` map is present**, so
`swamp extension fmt` / `swamp extension push` reject the inline form as soon as
you add a `deno.json` with an `imports` section — the same `deno.json` the
scorer strips. Break the deadlock one of two ways: disable the rule in your
`deno.json` (`"lint": { "rules": { "exclude": ["no-import-prefix"] } }`), or
suppress per-import with `// deno-lint-ignore no-import-prefix` above the zod
import line. The deadlock goes away entirely once the scorer honours the
tarball's `files/deno.json`.

**`fast-check` is subtle.** A single missing return type on an exported function
or a public export that leaks a private type costs the whole point. Run
`deno doc --lint <entrypoints>` locally to catch this before publish.

**`symbols-docs` means exported symbols, not internal helpers.** Only exports
count toward the 80% threshold. Private functions do not lower the score but
also do not raise it.

## Pre-publish quality checklist

Walk this before invoking `swamp-extension-publish`. Each row maps to a factor
and a concrete check.

1. `manifest.yaml` has a non-empty `description:`
2. `manifest.yaml` sets `repository:` to an HTTPS URL on github.com, gitlab.com,
   codeberg.org, or bitbucket.org
3. `manifest.yaml` lists every entrypoint file
   (models/drivers/vaults/datastores/reports as applicable)
4. `manifest.yaml` lists `README.md` and a LICENSE file under `additionalFiles:`
5. `manifest.yaml` either lists `platforms:` with ≥2 entries OR leaves the field
   empty
6. `README.md` is ≥500 characters with ≥2 fenced code blocks, one of which is a
   working usage example
7. LICENSE file present in the repo (any standard OSS license)
8. Every exported function has an explicit return type annotation
9. No public export references a private type
10. ≥80% of exported symbols carry a JSDoc comment
11. Every entrypoint file has a module-level JSDoc at the top
12. `deno doc --lint <entrypoints>` produces zero slow-type diagnostics
13. `deno doc --json <entrypoints>` runs without errors

If any row fails, fix it before handing off to `swamp-extension-publish`.

## Self-check your score locally

The CLI exposes the 10 client-earnable factors as a standalone command:

```
swamp extension quality manifest.yaml
swamp extension quality manifest.yaml --json
```

This packages the extension (reusing the push flow's packaging code), scores the
tarball contents against the rubric, and prints per-factor pass/fail with
remediation hints. The tarball is cached under `.swamp/cache/packages/<hash>/` —
if you run `swamp extension push` against the same source afterwards, it
transparently reuses the cached bytes so no work is duplicated.

Running `quality` is optional. `push` does not depend on it; running it just
surfaces rubric failures earlier and prepopulates the package cache.
`verified-by-swamp` is the one factor the CLI cannot score — it is reserved for
`@swamp` namespace or admin review and is granted server-side at publish time.

If `swamp extension quality` throws a `deno doc` error instead of printing
factor results, the entrypoint uses a bare specifier — see "Bare-specifier
imports fail `swamp extension quality`" above for the fix.

## Details when needed

For the full per-factor mechanics, the grade thresholds, and a worked example of
a manifest that earns every third-party point:

- **[references/rubric.md](references/rubric.md)** — complete factor reference
  with exact criteria, tarball layout, grade thresholds, score math.
- **[references/templates.md](references/templates.md)** — ready-to-use
  `manifest.yaml`, `README.md`, and JSDoc-annotated entrypoint skeletons.

Load the relevant reference file when an author needs more than the summary
above can give.

## When an author's score is already showing and they want to improve it

Work backwards from the factor breakdown rendered on the extension's Swamp Club
page. Each missing-row label maps 1:1 to an entry in the factor-to-action map
above. Do not speculate — look at the actual breakdown.

Common patterns:

- **`swamp extension quality` throws `Import "zod" not a dependency` instead of
  showing factor results** → entrypoint uses bare `"zod"`; switch to
  `"npm:zod@4"`. Adding `deno.json` to `additionalFiles:` does not resolve it.
- **"Has README" shows 0/2 but the repo has a README** → not listed in
  `additionalFiles:`, so it is not in the tarball. Publish a new version with
  the manifest fixed.
- **"License declared" shows 0/1 but LICENSE file exists** → same cause. Add it
  to `additionalFiles:`.
- **"No slow types" shows 0/1** → run `deno doc --lint <entrypoints>` locally;
  fix each diagnostic.
- **"Verified public repository" shows 0/2** → URL host is not allowlisted, URL
  is HTTP not HTTPS, or the repo is private/404.
- **"Most symbols documented" shows 0/1** → export JSDoc coverage is below 80%.

Every missing factor is a fixable factor.
