# Per-Input Disposable Instances

When a model method holds the instance lock for minutes (LLM calls, long network
IO), every dispatch serializes behind the lock. Create per-input ephemeral
instances to run them concurrently.

> **Not the same as ephemeral data.** The `ephemeral` data lifetime controls
> when _data_ is garbage-collected after a method completes. This recipe is
> about creating and deleting _model instances_ so that concurrent dispatches
> each get their own lock.

## When to Use

- The method's work is dominated by a long-running side effect keyed by an input
  (e.g., one plan per work item, one deploy per environment)
- Multiple dispatches need to run concurrently, not serialized
- The base model holds shared configuration (vault refs, context files) that
  every dispatch needs

## Shape

1. **Create** `<base>-<input>` on first dispatch for that input
2. **Run** the method on the per-input instance
3. **Delete** the instance on terminal completion (success or final failure)

## The Gotcha: Empty `globalArguments`

New instances start with **empty `globalArguments`**. If the base model uses
global arguments (API keys, context files, vault refs), the new instance won't
inherit them. Methods that read from `context.globalArgs` get `undefined`.

Re-pass every needed value when creating the instance.

### Option A: Direct Type Execution (preferred for literal values)

Direct execution auto-creates the instance and routes `--input` values to
`globalArguments` via the type's Zod schema:

```bash
# First run auto-creates asdlc-plan-PLT-1041 with routed global args
swamp model @acme/plan method run generate asdlc-plan-PLT-1041 \
  --input contextFiles="src/,docs/" \
  --input workItemId=PLT-1041
```

Inputs matching the `globalArguments` schema are persisted in the definition.
Subsequent runs on the same instance name reuse the existing definition.

See [direct-execution.md](direct-execution.md) for details on input routing.

### Option B: Explicit `model create` (required for CEL expressions)

When global arguments contain CEL expressions (vault refs, data refs, `self.*`),
use `model create --global-arg` so they are stored as literal strings and
evaluated at method-call time:

```bash
swamp model create @acme/plan asdlc-plan-PLT-1041 \
  --global-arg 'apiKey=${{ vault.get("prod-vault", "API_KEY") }}' \
  --global-arg 'contextFiles=src/,docs/' \
  --global-arg 'workItemId=PLT-1041'

swamp model method run asdlc-plan-PLT-1041 generate
```

CEL expressions like `${{ vault.get(...) }}` must go through `--global-arg` —
`--input` would store them as plain strings without CEL evaluation.

## Cleanup

Delete the instance after terminal completion:

```bash
swamp model delete asdlc-plan-PLT-1041
```

## Full Pattern

```bash
BASE="asdlc-plan"
INPUT="PLT-1041"
INSTANCE="${BASE}-${INPUT}"

# Create with all needed global args
swamp model create @acme/plan "$INSTANCE" \
  --global-arg 'apiKey=${{ vault.get("prod-vault", "API_KEY") }}' \
  --global-arg "contextFiles=src/,docs/" \
  --global-arg "workItemId=${INPUT}"

# Run the method — this instance has its own lock
swamp model method run "$INSTANCE" generate

# Clean up when done
swamp model delete "$INSTANCE"
```

## Related

- [direct-execution.md](direct-execution.md) — auto-creation and input routing
- [examples.md](examples.md) — vault secret references in global arguments
