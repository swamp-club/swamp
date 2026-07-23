# Direct Type Execution

The default way to run model methods. Pass inputs at runtime without managing
definition YAML files — the right choice for dynamic inputs, scripts, CI,
workflows, and any case where you don't need a persistent definition.

## CLI Syntax

```bash
swamp model @<type> method run <method> <name> --input key=value
```

```bash
swamp model @command/shell method run execute my-shell --input 'run=echo hello'
swamp model @test/greeter method run greet my-greeter \
  --input greeting=Hi --input name=World
```

## How It Works

**First run:** auto-creates a definition named `<name>` with the given type in
`.swamp/auto-definitions/`. Inputs are routed between global arguments and
method arguments using the type's Zod schemas — method args take precedence on
ambiguous keys, unknown keys are rejected.

**Subsequent runs:** finds the existing definition, verifies the type matches
(safety check), and runs. No new definition created.

## Storage

Auto-created definitions live in `.swamp/auto-definitions/{type}/{id}.yaml`.
They exist for data ownership boundaries — giving model data a home without
requiring a hand-authored definition file.

- Not git-tracked (local runtime state)
- Not visible in `swamp model search` or `swamp model list` (by design)
- Findable by name for `model get`, `model method run`, workflows
- `swamp model get` shows `Auto-created: yes` for these definitions
- Synced via datastores when configured (shared across team)

## Input Routing

When the type declares both `globalArguments` and method `arguments` schemas,
`--input` values are automatically split:

1. Keys matching the method's `arguments` schema → method arguments
2. Keys matching the type's `globalArguments` schema (not in method) → global
   arguments
3. Keys in neither schema → rejected with error listing valid keys

## When to Use `model create` Instead

Use explicit `model create` when you want to:

- Manage values in the definition file (edit with `model edit`)
- Version-control the definition in git
- Use CEL expressions in global arguments
- Share a definition across multiple workflow steps
