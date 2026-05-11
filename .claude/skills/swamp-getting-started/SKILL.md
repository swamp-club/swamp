---
name: swamp-getting-started
description: >
  Interactive getting-started walkthrough for new swamp users. Guides through
  understanding the user's goals, creating and running a first model,
  inspecting output, and choosing next steps. Uses a state-machine checklist
  with verification at each step.
  Triggers on "getting started", "get started", "new to swamp", "first time",
  "tutorial", "walkthrough", "onboarding", "how do I start", "what do I do
  first", "quickstart", "quick start", "hello world", "first model", "just
  installed swamp", "show me how swamp works", "intro to swamp", "new user",
  "set up swamp", "learn swamp".
---

# Getting Started with Swamp

A state machine. Each state gates the next — do not advance until the current
state's **Verify** passes. If Verify fails, run **On Failure** and re-verify. If
unsure a subcommand or flag exists, run `swamp <command> --help` rather than
guessing.

```
start → goals_understood → model_created → method_run
      → output_inspected → graduated
```

## Before Starting

Run `swamp model search --json`. If it returns models, the user is past
onboarding — say so and stop:

> You already have models set up. You're past the getting-started stage — just
> tell me what you'd like to work on and I'll use the right skill.

If the command fails, surface the error and suggest `swamp repo init` (delegate
to `swamp-repo` if needed), then return here. If no models exist, present the
5-step checklist (Goals → Create → Run → Inspect → Graduate) and begin State 1.

## State 1: goals_understood

**Gate:** None (first state).

**Action:** Ask what they want to automate, in their own words (not by
implementation type). Tell them they can skip if they already know swamp.

**Early exit:** If they describe a task with swamp terminology (e.g., "create a
model for X", "set up a workflow"), skip ahead and delegate directly to the
matching skill (`swamp-model`, `swamp-workflow`, `swamp-vault`, etc.).

**Verify:** The user described a goal. Then find a model type:

1. `swamp model type search <keywords> --json`
2. If nothing local: `swamp extension search <keywords> --json`
3. If an extension matches: `swamp extension pull <package>`
4. If nothing exists, offer a custom extension via `swamp-extension`. Use
   `command/shell` only for genuine one-off ad-hoc commands.

Store the goal — use it to name the model and tailor later examples.

**On Failure:** If the user is unsure, default to a `command/shell` model — no
credentials needed, demonstrates the full lifecycle.

## State 2: model_created

**Gate:** State 1 passed.

**Action:** Follow the resolution flow in
[references/tracks.md](references/tracks.md). Pick a name from the goal (e.g.,
"check disk space" → `check-disk-space`). Pattern:

1. Find or install the model type
2. `swamp model create <type> <name> --json`
3. Edit the YAML to match the goal

**Verify:** `swamp model validate <name> --json` passes with no errors. Show
warnings to the user.

**On Failure:** See "On Failure Recovery → State 2" in
[references/tracks.md](references/tracks.md).

## State 3: method_run

**Gate:** State 2 passed.

**Action:** Tell the user what's about to happen, then run
`swamp model method run <name> <method>`. Pick `<method>`:

- `command/shell`: `execute`
- Local typed: a read-only method first (`sync`, `get`)
- Extension: check `swamp model type describe <type> --json`

**Verify:** The run completes with `succeeded`.

**On Failure:** See "On Failure Recovery → State 3" in
[references/tracks.md](references/tracks.md). Re-run and re-verify.

## State 4: output_inspected

**Gate:** State 3 passed.

**Action:** `swamp model output get <name> --json`.

**Verify:** Output data is returned. Present to the user, highlighting status,
captured artifacts, datastore path, and the CEL reference path for wiring into
other models — see [references/tracks.md](references/tracks.md) for the CEL
pattern.

**On Failure:** See "On Failure Recovery → State 4" in
[references/tracks.md](references/tracks.md).

## State 5: graduated

**Gate:** State 4 passed.

**Action:** Summarize what they built. Suggest 2-3 concrete next steps tied to
their goal (e.g., "store your AWS credentials in a vault" — not "use the vault
skill"). Ask which they want, then delegate with full context. See the
Delegation Map in [references/tracks.md](references/tracks.md).

## References

[references/tracks.md](references/tracks.md) — model type resolution, credential
setup, method selection, CEL patterns, On Failure recovery per state, delegation
map.
