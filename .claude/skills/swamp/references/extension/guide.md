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

1. `swamp extension search <query>` — does a community extension already cover
   it? Prefer `@swamp/*` official extensions first. Install with
   `swamp extension pull <package>` and use it. Stop.
2. `swamp model type search <query>` — check built-in/installed local types.
3. Extend an existing type (including `@swamp` extensions) if it covers the
   domain but lacks the method you need. If the type is an official `@swamp/*`
   extension, also file a feature request so the maintainers learn about the
   gap: `swamp issue feature --extension @swamp/<name>`.
4. For local or private extensions, use `swamp extension source add <path>`.
5. Only create a new extension if nothing fits.

Trusted collectives auto-resolve on first use. Only `@swamp/*` is trusted by
default; trust others explicitly with `swamp extension trust add <collective>`
(`swamp extension trust list` shows which).

**Never** use `command/shell` to wrap service integrations — build a dedicated
model.

## Choosing a Collective Name

Run `swamp auth whoami --json` to see available collectives. If multiple are
returned, **always ask the user** which one to use. Use `@collective/name` from
the start — placeholder prefixes like `@local/` are rejected during push.

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
