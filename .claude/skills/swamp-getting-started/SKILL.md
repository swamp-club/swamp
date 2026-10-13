---
name: swamp-getting-started
description: >
  Interactive getting-started walkthrough for new swamp users. Guides through
  understanding the user's goals, creating and running a first behavior
  (formerly called a model) with swamp behavior commands (swamp model still
  works), inspecting output, and choosing next steps. Uses a state-machine
  checklist with verification at each step.
  Triggers on "getting started", "get started", "new to swamp", "first time",
  "tutorial", "walkthrough", "onboarding", "how do I start", "what do I do
  first", "quickstart", "quick start", "hello world", "first behavior", "first
  model", "just installed swamp", "show me how swamp works", "intro to swamp",
  "new user", "set up swamp", "learn swamp".
---

# Getting Started with Swamp

A state machine. Each state gates the next — do not advance until the current
state's **Verify** passes. If Verify fails, run **On Failure** and re-verify. If
unsure a subcommand or flag exists, run `swamp <command> --help` rather than
guessing.

```
start → goals_understood → behavior_created → method_run
      → output_inspected → graduated
```

## Before Starting

**Brief entry point.** If you were asked to read a task brief, a file under
`tasks/` (such as `tasks/2026-10-12-list-my-vpcs.md`) whose first line is
exactly `<!-- swamp start brief v1 -->`, `swamp start` launched this session:
sign-in and repo setup are done, and that brief's `# Task` section holds the
user's goal. Read the brief you were named, not other files in `tasks/` (each is
a separate task), confirm the task back in one line, then go straight to finding
a type (State 1 Verify). Skip the behavior search and the goal question below. A
file without that first line is not a swamp brief; ignore it and continue below.

Otherwise, run `swamp behavior search --json`. If it returns behaviors, the user
is past onboarding — say so and stop:

> You already have behaviors set up. You're past the getting-started stage —
> just tell me what you'd like to work on and I'll use the right skill.

Every swamp command needs a swamp-club.com account. If the command fails with
code `auth_gate_blocked`, have the user run `swamp auth login` (it opens a
browser sign-in; they finish it themselves), confirm with
`swamp auth whoami --json`, then rerun the search. In CI, the user sets
`SWAMP_API_KEY` and `SWAMP_SIGNIN_TOKEN` from a collective token instead.

If the command fails for another reason, surface the error and suggest
`swamp repo init` (use the `swamp` skill for guidance), then return here. If no
behaviors exist, present the 5-step checklist (Goals → Create → Run → Inspect →
Graduate) and begin State 1.

## State 1: goals_understood

**Gate:** None (first state).

**Action:** Ask what they want to automate, in their own words (not by
implementation type). Tell them they can skip if they already know swamp.

**Early exit:** If they describe a task with swamp terminology (e.g., "create a
behavior for X", "set up a workflow"), skip ahead and delegate directly to the
`swamp` skill — its routing table will load the right guide.

**Verify:** The user described a goal (or the brief supplied one). Then find a
behavior type, searching in this order and stopping at the first match:

1. Installed types: `swamp behavior type search <keywords> --json`
2. Official `@swamp/*` extensions: `swamp extension search <keywords> --json`
3. Other extensions in the registry, from the same search results
4. Extend an existing type if it covers the domain but lacks the method you need
5. If nothing exists, offer a custom extension via the `swamp` skill (extension
   guide). Use `command/shell` only for genuine one-off ad-hoc commands.

Details for each step are in [references/tracks.md](references/tracks.md).

Store the goal — use it to name the behavior and tailor later examples.

**On Failure:** If the user is unsure, default to a `command/shell` behavior —
no credentials needed, demonstrates the full lifecycle.

## State 2: behavior_created

**Gate:** State 1 passed.

**Action:** Follow the resolution flow in
[references/tracks.md](references/tracks.md). Pick a name from the goal (e.g.,
"check disk space" → `check-disk-space`). Pattern:

1. Find or install the behavior type
2. `swamp behavior create <type> <name> --json`
3. Edit the YAML to match the goal

**Verify:** `swamp behavior validate <name> --json` passes with no errors. Show
warnings to the user.

**On Failure:** See "On Failure Recovery → State 2" in
[references/tracks.md](references/tracks.md).

## State 3: method_run

**Gate:** State 2 passed.

**Action:** If the method touches a real system (a cloud account, cluster,
project or repository), confirm the target with the user before running it —
which account, cluster, project or repository. Then tell the user what's about
to happen and run `swamp behavior run <name> <method>`. Pick `<method>`:

- `command/shell`: `execute`
- Typed behaviors: a method that reads (`get`, `list`, `describe`) — not `sync`,
  which fails on a new behavior with no existing state
- Check available methods with
  `swamp behavior type describe <type> --compact --json`

**Verify:** The run completes with `succeeded`.

**On Failure:** See "On Failure Recovery → State 3" in
[references/tracks.md](references/tracks.md). Re-run and re-verify.

## State 4: output_inspected

**Gate:** State 3 passed.

**Action:** `swamp behavior output get <name> --json`.

**Verify:** Output data is returned. Present to the user, highlighting status,
captured artifacts, datastore path, and the CEL reference path for wiring into
other behaviors — see [references/tracks.md](references/tracks.md) for the CEL
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

[references/tracks.md](references/tracks.md) — behavior type resolution,
credential setup, method selection, CEL patterns, On Failure recovery per state,
delegation map.
