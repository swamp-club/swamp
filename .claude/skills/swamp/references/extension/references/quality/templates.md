# Templates for a Grade A extension

Ready-to-adapt skeletons that hit every earnable factor for a third-party
extension. Adjust names, content, and extension type to taste; the structure is
what earns the score.

## `manifest.yaml` — full example

```yaml
manifestVersion: 1
name: "@mycollective/my-extension"
version: "2026.04.22.1"
description: "One clear sentence about what this extension does and who would use it."

repository: https://github.com/mycollective/my-extension

additionalFiles:
  - README.md
  - LICENSE

# Choose whichever field applies to your extension type.
# Pick one — or multiple — and remove the rest.
models:
  - my-model.ts
# drivers:
#   - my-driver.ts
# vaults:
#   - my-vault.ts
# datastores:
#   - my-datastore.ts
# reports:
#   - my-report.ts

# Empty platforms is "universal" — earns both platform factors.
# Populate with ≥2 entries if the extension is actually platform-specific.
platforms:
  - linux-x86_64
  - darwin-aarch64
```

Fields to double-check before publishing:

- `description` is not `"TODO"`, `"tbd"`, or an empty string
- `repository` is HTTPS and on github.com, gitlab.com, codeberg.org, or
  bitbucket.org
- Both `README.md` and a LICENSE file are listed in `additionalFiles:`
- `platforms:` is either empty or has ≥2 entries (a single explicit platform
  fails `platforms-two`)

## Per-extension-subdir layout — opt-in `paths.base: manifest`

The template above assumes the historical layout: manifest at the repository
root or directly inside `extensions/models/`, source files under
`extensions/models/`, README and LICENSE alongside the manifest. **That layout
keeps working unchanged — there is no migration required for any existing
extension.**

If you prefer to keep each extension self-contained in its own subdirectory
under `extensions/models/` (manifest, source, README, LICENSE all alongside each
other), opt in with `paths.base: manifest`. The default is unchanged in the code
(a single ternary picks between the configured typed dir and the manifest's own
directory), so omitting the field is the same as writing `paths.base: typedDir`
— historical behavior. See
[swamp-extension-publish references/publishing.md](../../../swamp-extension-publish/references/publishing.md#path-resolution--pathsbase)
for the canonical reference.

```yaml
manifestVersion: 1
name: "@mycollective/my-extension"
version: "2026.04.22.1"
description: "One clear sentence about what this extension does."
repository: https://github.com/mycollective/my-extension

paths:
  base: manifest # opt-in; remove the field to keep the historical default

models:
  - my-model.ts # resolves alongside this manifest, not under extensions/models/
additionalFiles:
  - README.md # same — alongside the manifest
  - LICENSE
platforms:
  - linux-x86_64
  - darwin-aarch64
```

This shape keeps the file layout flat (manifest beside source beside README)
without forcing directory prefixes on `models:`. It makes no difference to the
rubric score itself — both layouts can earn full marks — but it removes the
mental friction authors hit when restructuring to land README at the archive
root.

## `README.md` — minimal substantive template

Needs ≥500 characters total and ≥2 fenced code blocks. This template clears both
bars.

````markdown
# @mycollective/my-extension

One paragraph explaining what this extension does. Keep it concrete — what
problem it solves, what inputs it accepts, what side effects it has. The goal is
that a reader can decide in 30 seconds whether this extension is relevant to
them.

## Installation

```sh
swamp extension install @mycollective/my-extension
```

## Usage

```ts
import { validate } from "./my-model.ts";

const input = validate({
  name: "example-input",
  limit: 10,
});
```

## How it works

A short paragraph on the mechanics. Mention any prerequisites: environment
variables, external services, required permissions, network access, or
credentials in the vault. If the extension depends on other swamp extensions,
list them here.

## License

MIT — see LICENSE for details.
````

## Entrypoint skeleton — JSDoc-annotated TypeScript

Earns `symbols-docs` (≥80% JSDoc coverage), `fast-check` (explicit return types,
no private-type leaks), and the module-level doc signal for `has-readme`.

```ts
/**
 * Module-level doc. Two or three sentences explaining what this
 * entrypoint is for and when someone would import or invoke it. Keep
 * implementation details out — they belong in per-symbol docs below.
 *
 * @module
 */

import { z } from "npm:zod@4";

/** Accepted input shape for this model's operations. */
export const argsSchema = z.object({
  name: z.string().describe("The name of the thing to process."),
  limit: z.number().int().positive().describe("Maximum items to return."),
});

/** Resolved input type, derived from `argsSchema`. */
export type Args = z.infer<typeof argsSchema>;

/** Shape returned from a successful operation. */
export interface Result {
  processed: number;
  skipped: number;
}

/** Validate caller-supplied arguments and return a typed object. */
export function validate(input: unknown): Args {
  return argsSchema.parse(input);
}

/** Process the validated arguments and return a Result. */
export async function run(args: Args): Promise<Result> {
  // implementation
  return { processed: args.limit, skipped: 0 };
}
```

Rules this example demonstrates:

- **Every export has a JSDoc comment** — hits the 80% threshold easily.
- **Explicit return types on every exported function** (`: Args`,
  `: Promise<Result>`).
- **All public types are themselves exported** (`Args`, `Result`, `argsSchema`)
  — so nothing exposed through the API refers to a private type.
- **Module-level `@module` block at the top** — satisfies module-doc detection.
- **Inline `npm:zod@4` specifier**, not bare `"zod"`. The scorer and
  `swamp extension quality` run in a hermetic sandbox that strips the repo's
  `deno.json` and writes its own with no imports map, so a bare specifier cannot
  resolve at score time even when an import map maps it at bundle time.

## Pre-publish command sequence

Run from the extension's directory before invoking `swamp extension push`:

```sh
# Verify types and catch slow-type issues.
deno doc --lint models/my-model.ts
# Exit status 0 + no output means clean.

# See extracted doc structure — confirms exports are well-shaped.
deno doc --json models/my-model.ts | jq '.nodes | keys'

# Verify formatting and standard lint.
deno fmt --check
deno lint
```

Any diagnostic from `deno doc --lint` costs the `fast-check` point. Fix each one
before pushing.

## Common mistakes and their fixes

| Mistake                                                          | Consequence                                                        | Fix                                                                                                                                                                                                              |
| ---------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| README in repo root but not in `additionalFiles:`                | `has-readme` 0/2, `readme-example` 0/1, `rich-readme` 0/1 = -4 pts | Add `README.md` to `additionalFiles:` in the manifest. For per-extension-subdir layouts, set `paths.base: manifest` so the README beside the manifest resolves with a bare basename (default mode is unchanged). |
| LICENSE file in repo but not in `additionalFiles:`               | `has-license` 0/1 = -1 pt                                          | Add the LICENSE file to `additionalFiles:`. Same `paths.base: manifest` opt-in available if your LICENSE sits alongside a per-directory manifest.                                                                |
| Missing return type on one exported function                     | `fast-check` 0/1 = -1 pt                                           | Add explicit `: ReturnType` annotation                                                                                                                                                                           |
| Description set to `"TODO"`                                      | technically passes, wastes the signal                              | Write a real one-sentence description                                                                                                                                                                            |
| `repository:` URL is HTTP not HTTPS                              | `repository-verified` 0/2 = -2 pts                                 | Switch to `https://`                                                                                                                                                                                             |
| `repository:` on self-hosted GitLab or Gitea                     | `repository-verified` 0/2 = -2 pts                                 | Use a public mirror on github.com or gitlab.com if possible                                                                                                                                                      |
| `platforms:` has exactly one entry                               | `platforms-two` 0/1 = -1 pt                                        | Either leave empty (universal) or list ≥2                                                                                                                                                                        |
| One exported helper without a JSDoc comment, out of five exports | `symbols-docs` 0/1 = -1 pt                                         | Add JSDoc to hit ≥80% coverage                                                                                                                                                                                   |
