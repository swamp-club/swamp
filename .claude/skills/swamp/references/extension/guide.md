# Swamp Extension

Create TypeScript extensions that swamp loads at startup. Five extension types
share the same workflow: implement an interface, register in a manifest, publish
via `swamp-extension-publish`.

## Determine Extension Type

| User intent                                    | Type      | Export                   | Location                         |
| ---------------------------------------------- | --------- | ------------------------ | -------------------------------- |
| New data source, API integration, automation   | Model     | `export const model`     | `extensions/models/*.ts`         |
| Custom secret backend (HashiCorp Vault, 1P, …) | Vault     | `export const vault`     | `extensions/vaults/*/mod.ts`     |
| Control where/how model methods execute        | Driver    | `export const driver`    | `extensions/drivers/*/mod.ts`    |
| Custom storage backend (GCS, DB, …)            | Datastore | `export const datastore` | `extensions/datastores/*/mod.ts` |
| Repeatable analysis of model/workflow output   | Report    | `export const report`    | `extensions/reports/*.ts`        |

## Before Creating an Extension

1. **Search the registry.** Use filters to narrow results — don't rely on broad
   keyword searches. Search by **service name**, not operation name (e.g. `ec2`
   not `ebs` — extensions are organized by service, operations are methods
   within types).

   ```
   swamp extension search <service> --platform <platform> --content-type models --json
   ```

   Available filters: `--platform` (aws, gcp, azure, …), `--content-type`
   (models, workflows, vaults, datastores, drivers, reports), `--label`,
   `--collective`. Prefer `@swamp/*` official extensions first.

2. **Inspect before pulling.** Once you find a candidate, check its types and
   methods with `extension info` — don't pull until you confirm it has what you
   need:

   ```
   swamp extension info <package> --json
   ```

   The `contentMetadata` field in the JSON output lists every model type with
   its methods and arguments, plus workflows, vaults, and other content. If the
   type or method you need isn't listed, don't pull — move to step 5.

3. **Pull and use.** If the extension has the right type and method, install it:
   `swamp extension pull <package>`. Stop.

4. **Check local types.** `swamp model type search <query>` — check
   built-in/installed local types. **Cold-repo shortcut:** if no extensions are
   installed (fresh repo, CI environment), skip this step — local search is
   guaranteed-empty.

5. **Extend an existing type** (including `@swamp` extensions) if it covers the
   domain but lacks the method you need. If the type is an official `@swamp/*`
   extension, also file a feature request so the maintainers learn about the
   gap: `swamp issue feature --extension @swamp/<name>`.

6. **Confirmed no type/method exists?** If `extension info` and `type search`
   both confirm no type or method covers the operation, stop searching.
   `command/shell` or a custom model is the correct approach — file a feature
   request (`swamp issue feature --extension @swamp/<name>`) to track the gap.

7. For local or private extensions, use `swamp extension source add <path>`.

8. Only create a new extension if nothing fits.

Trusted collectives auto-resolve on first use. Only `@swamp/*` is trusted by
default; trust others explicitly with `swamp extension trust add <collective>`
(`swamp extension trust list` shows which).

Don't use `command/shell` when an extension type covers the operation. If
`extension info` confirms no type or method exists for the operation,
`command/shell` or a custom model is the correct approach — file a feature
request to track the gap.

## Choosing a Collective Name

Run `swamp auth whoami --json` to see available collectives. If multiple are
returned, **always ask the user** which one to use. Use `@collective/name` from
the start — placeholder prefixes like `@local/` are rejected during push.

## Import Rules

Always use `import { z } from "npm:zod@4";` in source files — never bare
`from "zod"`. A `deno.json` imports map may map `"zod"` for local tooling, but
source files must still use the inline `npm:zod@4` specifier. The swamp-club
scorer runs `deno doc --lint` in a hermetic sandbox that strips the repo's
`deno.json` and writes its own with no imports map, so bare specifiers resolve
locally but fail at score time.

## Quick Reference

| Task                | Command/Action                                 |
| ------------------- | ---------------------------------------------- |
| Search community    | `swamp extension search <query> --json`        |
| Verify registration | `swamp model type search --json`               |
| Verify it loads     | `swamp doctor extensions --json`               |
| Inspect catalog     | `swamp doctor extensions --verbose`            |
| Repair stale state  | `swamp doctor extensions --repair`             |
| Next version        | `swamp extension version --manifest m.yaml -j` |
| Create manifest     | Create `manifest.yaml` with extension entries  |
| Format extension    | `swamp extension fmt manifest.yaml --json`     |
| Check formatting    | `swamp extension fmt manifest.yaml --check -j` |
| Quality score       | `swamp extension quality manifest.yaml --json` |
| Dry-run push        | `swamp extension push manifest.yaml --dry-run` |
| Push extension      | `swamp extension push manifest.yaml --json`    |

For detailed walkthroughs of each operation, see [reference.md](reference.md).
