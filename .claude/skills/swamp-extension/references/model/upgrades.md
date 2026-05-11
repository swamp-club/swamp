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

When bumping a model's `version`, **always prompt the user** before writing the
upgrade. Claude cannot reliably determine whether or how the schema changed.

1. Run `swamp extension version @collective/name --json` to get the current
   published version (`currentPublished`) and the next version (`nextVersion`)
2. Ask: "Did the `globalArguments` schema change between versions?"
3. If **yes**: ask what fields were added, renamed, removed, or changed type —
   and what default values to use for new/changed fields
4. If **no**: add a no-op upgrade (see below) — still required to bump
   `typeVersion` on existing instances
5. Set the model's `version` to `nextVersion` from the CLI output
6. Set the upgrade's `toVersion` to the same `nextVersion`
7. The `fromVersion` baseline for the upgrade chain is `currentPublished` — this
   is the **published registry version**, not the version in the local source
   file on the current branch

## How Upgrades Work

Upgrades are **lazy** — they run at method execution time, not at load time:

1. User runs a method on an instance with an old `typeVersion`
2. `DefinitionUpgradeService` filters the model's `upgrades` array to entries
   with `toVersion > definition.typeVersion`
3. Applicable upgrades run in order, each transforming `globalArguments`
4. The upgraded definition is persisted with the new `typeVersion`
5. The upgrade only runs once — subsequent method calls skip it

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

A model evolving through multiple versions builds up a chain. Each entry handles
one version transition:

```typescript
export const model = {
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
- The last upgrade's `toVersion` **must** equal the model's current `version`
- Upgrade functions are pure transforms (old args in, new args out)
- Upgrades are forward-only — there is no downgrade path
- The registry validates these rules at startup and throws on violations

## Without Upgrades

If a model bumps `version` without adding an `upgrades` entry:

- Existing instances keep their old `typeVersion` forever
- Methods still execute if the schema is compatible (no new required fields)
- But `typeVersion` never updates, making it impossible to tell which instances
  have been migrated
- Future upgrades that chain from the new version will skip these instances
