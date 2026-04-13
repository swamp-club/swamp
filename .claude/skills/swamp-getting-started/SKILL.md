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

Interactive walkthrough for new users. This skill is a **state machine** — each
state gates the next. You MUST NOT advance to the next state until the current
state's **Verify** step passes.

## State Machine

```
start → goals_understood → model_created → method_run
      → output_inspected → graduated
```

**Core rule:** If any Verify fails, execute the On Failure action. Never skip a
state. Never reorder states. Each step validates before advancing.

**Do not guess CLI commands.** If you are unsure whether a subcommand or flag
exists, run `swamp <command> --help` to check before using it. Never invent
commands — only use what the CLI actually provides.

## Before Starting

**Pre-check:** Before presenting the walkthrough, run
`swamp model search --json`. If the command succeeds and returns models, the
user does not need onboarding. Skip the entire walkthrough and say:

> You already have models set up. You're past the getting-started stage — just
> tell me what you'd like to work on and I'll use the right skill.

Then stop. Do not proceed with the state machine.

If the command fails (repo not initialized, corrupt config, swamp not
installed), do not silently skip onboarding. Tell the user what went wrong and
suggest running `swamp repo init` first. If the repo isn't initialized, delegate
to the `swamp-repo` skill for setup, then return here to continue the
walkthrough.

**If no models exist**, present the 5-step checklist (Goals → Create → Run →
Inspect → Graduate) so the user knows what to expect. Also tell the user:

- They can ask you to **explain your plan** before you execute anything — you'll
  research and present an approach for their approval before making changes
- They should **review what you propose** at each step — they're in control and
  can steer the direction

Then begin with State 1.

## State 1: goals_understood

Understand what the user wants to accomplish with swamp so the rest of the
walkthrough is tailored to their goals.

**Gate:** None (first state).

**Action:** Ask the user what they want to automate. Don't categorize by
implementation (shell vs cloud vs extension) — just ask them to describe their
goal in their own words. Examples: "check disk space on my servers", "manage AWS
EC2 instances", "monitor my API uptime", "deploy to Kubernetes". Let them know
they can skip the walkthrough if they already know swamp.

**Early exit:** If the user's response indicates they already know swamp (e.g.,
"I want to create a model for X", "set up a workflow", or describes a specific
task with swamp terminology), skip the rest of this walkthrough. Instead,
delegate directly to the appropriate skill (`swamp-model`, `swamp-workflow`,
`swamp-vault`, etc.) and proceed with their request.

**Verify:** The user has described their goal. Find the right model type:

1. Search local types: `swamp model type search <keywords> --json`
2. If nothing local matches, search extensions:
   `swamp extension search <keywords> --json`
3. If an extension is found, pull it: `swamp extension pull <package>`
4. If nothing exists, offer to build a custom extension model using the
   `swamp-extension-model` skill. Only use `command/shell` if the user's goal is
   genuinely a one-off ad-hoc command (not wrapping a CLI tool or service)

Store the user's goal description — use it to name models and tailor examples
throughout the remaining steps.

**On Failure:** If the user is unsure, default to a `command/shell` model. It
works everywhere without credentials and demonstrates the full lifecycle.

## State 2: model_created

Create the user's first model, tailored to their stated goal.

**Gate:** State 1 passed (goals understood, model type chosen).

**Action:** Follow the resolution steps in
[references/tracks.md](references/tracks.md) to create the model. Use the user's
goal to pick a meaningful model name (e.g., "check disk space" →
`check-disk-space`).

The general pattern regardless of model type:

1. Find or install the right model type
2. Create the model with `swamp model create <type> <name> --json`
3. Edit the generated YAML to configure arguments matching the user's goal

### Verify

```bash
swamp model validate <name> --json
```

Validation must pass with no errors. Show any warnings to the user.

**On Failure:** Read the validation errors. Common fixes:

- Missing required arguments → edit the model YAML to add them
- Invalid argument values → check the type schema with
  `swamp model type describe <type> --json`
- File not found → verify path from `swamp model get <name> --json`

For detailed model guidance, see the `swamp-model` skill.

## State 3: method_run

Execute a method on the model to show swamp in action.

**Gate:** State 2 passed (model validates).

**Action:** Tell the user what's about to happen, then run:

```bash
swamp model method run <name> <method>
```

Where `<method>` is:

- Shell models (`command/shell`): `execute`
- Local typed models: the appropriate read-only method first (e.g., `sync`,
  `get`) — prefer non-destructive methods for a first run
- Extension models: depends on the extension type — check available methods with
  `swamp model type describe <type> --json`

**Verify:** The command completes with a `succeeded` status.

**On Failure:**

- **Command failed**: Read the error output and suggest specific fixes
- **Missing secrets**: Guide toward vault setup (delegate to `swamp-vault`
  skill)
- **Permission denied**: Check the command exists and is executable
- **Timeout**: Suggest a simpler command for the first run

After fixing, re-run the method and re-verify.

## State 4: output_inspected

Show the user what swamp captured and where data lives.

**Gate:** State 3 passed (method succeeded).

**Action:**

```bash
swamp model output get <name> --json
```

**Verify:** The command returns output data. Present the results to the user,
highlighting:

- **Status**: succeeded
- **Data artifacts**: what was captured (stdout, resource attributes, etc.)
- **Where it lives**: the datastore path for versioned data
- **How to reference it**: the CEL expression path for wiring to other models

Explain that swamp versions every method run's output, and show the CEL
expression pattern for referencing it from other models:
`${{ data.latest("<name>", "<dataName>").attributes.<field> }}`

**On Failure:** If no output is found, check the method run logs:

```bash
swamp model output search <name> --json
```

Look for failed runs and report the error.

## State 5: graduated

Celebrate success and show the user where to go next based on their stated
goals.

**Gate:** State 4 passed (output inspected).

**Action:** No verification needed. Summarize what they accomplished (model
created, method run, output captured). Then:

1. Remind the user about working styles they can use going forward:
   - **Plan mode**: Ask Claude to plan before acting — it will research the
     codebase and present an approach for approval before making changes
   - **Review changes**: They can always ask to see what Claude will do before
     it does it, and steer the direction at any point
   - **Iterate**: They can ask Claude to adjust, undo, or try a different
     approach at any time

2. Suggest 2-3 concrete next steps based on their model type and goal — not
   generic skill names, but specific actions tied to what they just built (e.g.,
   "store your AWS credentials in a vault" not "help me create a vault"). Ask
   which direction they want to go, then delegate to the appropriate skill with
   full context about what they've already built.

## Delegation

When the user picks a next step (or asks something outside the walkthrough
scope), delegate to the appropriate skill with context about what they built:

- User wants another model or to edit the one they made → `swamp-model`
- User wants to chain models together → `swamp-workflow`
- User wants to secure credentials → `swamp-vault`
- User wants to inspect or query their data → `swamp-data-query`
- User wants to build a typed model from scratch → `swamp-extension-model`
- User wants to share their work → `swamp-extension-publish`
- Something is broken → `swamp-troubleshooting`

Always pass along the user's original goal and what they built so the next skill
doesn't start from zero.

## References

See [references/tracks.md](references/tracks.md) for the model type resolution
flow, credential setup, method selection, and CEL reference patterns.
