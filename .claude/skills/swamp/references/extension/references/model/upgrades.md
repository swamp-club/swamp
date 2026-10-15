# Version Upgrades

## Table of Contents

- [User Prompt Workflow](#user-prompt-workflow)
- [How Upgrades Work](#how-upgrades-work)
- [Upgrade Entry Structure](#upgrade-entry-structure)
- [Common Patterns](#common-patterns)
- [Multi-Step Upgrade Chain](#multi-step-upgrade-chain)
- [Rules](#rules)
- [Without Upgrades](#without-upgrades)

## User Prompt Workflow

When bumping a behavior's `version`, **always prompt the user** before writing
the upgrade. Claude cannot reliably determine whether or how the schema changed.

1. Run `swamp extension version @collective/name --json` to get the current
   published version (`currentPublished`) and the next version (`nextVersion`)
2. Ask: "Did the `globalArguments` schema change between versions?"
3. If **yes**: ask what fields were added, renamed, removed, or changed type —
   and what default values to use for new/changed fields
4. If **no**: add a no-op upgrade (see below) — still required to bump
   `typeVersion` on existing instances
5. Set the behavior's `version` to `nextVersion` from the CLI output
6. Set the upgrade's `toVersion` to the same `nextVersion`
7. The `fromVersion` baseline for the upgrade chain is `currentPublished` — this
   is the **published registry version**, not the version in the local source
   file on the current branch

## How Upgrades Work

Upgrades are **lazy** — they run at method execution time, not at load time:

1. User runs a method on an instance with an old `typeVersion`
2. `DefinitionUpgradeService` filters the behavior's `upgrades` array to entries
   with `toVersion > definition.typeVersion`
3. Applicable upgrades run in order, each transforming `globalArguments`
4. The upgraded definition is persisted with the new `typeVersion`. Only the
   values that changed are rewritten: comments, anchors and formatting elsewhere
   in the YAML survive. A legacy `<uuid>.yaml` file moves to `<name>.yaml` on
   this save, and the run logs both the upgrade and the move.
5. The upgrade only runs once — subsequent method calls skip it

`swamp behavior validate` and the check before each workflow step apply the
chain to an in-memory copy first, without saving it, so a stale instance
validates when its upgrade succeeds. An `upgradeAttributes` that throws fails
the `Global arguments` item. Instances whose global arguments hold `${{ }}`
expressions are not upgraded in validation, only at run time. A workflow step
therefore runs the chain twice, so keep `upgradeAttributes` pure: same input,
same output, no side effects.

Every step above needs a `typeVersion` to compare against. An instance that
records none is left exactly as written — no upgrade runs, and nothing is
stamped. Absence cannot distinguish arguments that predate your chain from
arguments already in the shape your current version expects, and applying the
chain to the latter would transform them a second time (swamp-club#2412). A
method run warns when this happens, and the fix is to add the `typeVersion` line
recording the version those arguments were authored for.

A `typeVersion` that is present but not valid CalVer — `"1.0"`, `1`, anything
the format does not accept — fails the run outright. That is deliberate: the
author meant to say something, and quietly ignoring it is worse than stopping.

`typeVersion` advances **only** when an upgrade actually migrates the arguments,
or when the definition is first created. Nothing else may touch it — persisting
a definition for any other reason leaves it alone. This matters: once
`typeVersion` reaches the behavior's version the upgrade service stops
considering that instance, so advancing it without migrating would strand the
instance permanently (swamp-club#900).

## Spotting a Stranded Instance

`swamp behavior get <instance>` reports three fields:

- `typeVersion` — the version the instance's arguments were authored or migrated
  for
- `currentTypeVersion` — the version of the installed behavior type
- `staleness` — `current`, `upgradable`, `stranded`, `unknown`, or `invalid`

`stranded` means the installed version is ahead and **no upgrade entry covers
the gap**, so nothing will ever migrate that instance. A method run against it
also logs a warning. The fix is on the extension side: ship the `upgrades` entry
that should have accompanied the version bump. This is why the no-op upgrade
below is not optional.

`unknown` means the instance records no `typeVersion` at all, so your chain will
not run against it. `invalid` means it records one that is not CalVer, and
method runs against it fail until it is corrected. Both are fixed in the
definition, not the extension.

## Upgrade Entry Structure

```typescript
{
  toVersion: string,        // CalVer target version (YYYY.MM.DD.MICRO)
  description: string,      // Human-readable summary of the change
  upgradeAttributes: (old: Record<string, unknown>) => Record<string, unknown>,
}
```

## Common Patterns

### No-op upgrade (version bump, no schema change)

```typescript
upgrades: [
  {
    toVersion: "2026.03.25.2",
    description: "Version bump, no schema changes",
    upgradeAttributes: (old) => old,
  },
],
```

### Add a new field with default

```typescript
{
  toVersion: "2026.03.25.1",
  description: "Add priority field with default 'medium'",
  upgradeAttributes: (old) => ({ ...old, priority: "medium" }),
}
```

### Rename a field

```typescript
{
  toVersion: "2026.03.25.1",
  description: "Rename 'message' to 'content'",
  upgradeAttributes: (old) => {
    const { message, ...rest } = old;
    return { ...rest, content: message };
  },
}
```

### Remove a field

```typescript
{
  toVersion: "2026.03.25.1",
  description: "Remove deprecated 'legacyFlag' field",
  upgradeAttributes: (old) => {
    const { legacyFlag: _, ...rest } = old;
    return rest;
  },
}
```

## Multi-Step Upgrade Chain

A behavior evolving through multiple versions builds up a chain. Each entry
handles one version transition:

```typescript
export const behavior = {
  type: "acme/notifier",
  version: "2026.02.09.1",
  globalArguments: z.object({
    content: z.string().min(1),
    priority: z.enum(["low", "medium", "high"]),
  }),
  upgrades: [
    {
      toVersion: "2025.06.01.1",
      description: "Add priority field with default 'medium'",
      upgradeAttributes: (old) => ({ ...old, priority: "medium" }),
    },
    {
      toVersion: "2026.02.09.1",
      description: "Rename 'message' to 'content'",
      upgradeAttributes: (old) => {
        const { message, ...rest } = old;
        return { ...rest, content: message };
      },
    },
  ],
  methods: {/* ... */},
};
```

An instance at `2025.01.15.1` with `{ message: "hello" }` would:

1. Apply upgrade to `2025.06.01.1`: `{ message: "hello", priority: "medium" }`
2. Apply upgrade to `2026.02.09.1`: `{ content: "hello", priority: "medium" }`
3. Persist with `typeVersion: "2026.02.09.1"`

An instance already at `2025.06.01.1` would only apply step 2.

## Rules

- Upgrades must be ordered chronologically by `toVersion`
- The last upgrade's `toVersion` **must** equal the behavior's current `version`
- Upgrade functions are pure transforms (old args in, new args out)
- Upgrades are forward-only — there is no downgrade path
- The registry validates these rules at startup and throws on violations

## Without Upgrades

If a behavior bumps `version` without adding an `upgrades` entry:

- Existing instances keep their old `typeVersion` forever
- Methods still execute if the schema is compatible (no new required fields)
- But `typeVersion` never updates, making it impossible to tell which instances
  have been migrated
- Future upgrades that chain from the new version will skip these instances
