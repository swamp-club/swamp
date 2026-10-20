---
audience: maintainer
enables: [workflows]
last-verified: 2026-10-20 @ a71ff13e
---

# Pinned Workflow Inputs

**Status:** implemented on the swamp-club#3583 branch, as one PR.
[workflows](../primitives/workflows.md) (Resume inputs) describes the shipped
behavior; this page keeps the reasoning and the decisions.

## Outcome

A step never acts on an input value that differs from one the steps before it
saw. Three rules give that:

- **Inputs are write-once.** Once a run has a value for an input, it keeps that
  value. A resume may add inputs the run does not have. Changing one needs a new
  run.
- **A `--last-evaluated` run runs with the inputs its cache was evaluated
  with.** A supplied `--input` must equal the recorded value. The run records
  the cache's inputs. This is checked before the run starts, on one load of the
  cache that superseding and execution share.
- **A `--last-evaluated` run evaluates behavior definitions fresh.** Only the
  workflow is replayed from cache. Each behavior step evaluates its definition
  against the run's inputs, as a fresh run does.

**The guarantee and its limit.** The guarantee covers values. An input the run
has cannot change under a finished step. It does not cover absence. An input
the run does not have can arrive at resume, and a step that ran before it
arrived may have tested for it and seen nothing, or read a fallback in its
place. The plan does not detect that. It documents the pattern that makes a
late input safe: check it after it arrives ([Late inputs](#late-inputs)).

The first rule ends the pattern of passing a placeholder at start and overriding
it at resume. An input supplied at resume is declared optional and read in a
form that tolerates its absence. That change, and the limit above, are the main
decisions this design makes.

## Background

swamp-club#3583: `swamp workflow resume --input` could change an input that a
finished step had already acted on.

A workflow suspends at a `manual_approval` or `wait_for_signal` step. Resume
merges `--input` over the run's stored inputs. That lets a value that did not
exist at start, such as the vault key name of a credential issued during the
gate, be supplied later. Nothing stopped a resume from also changing a value an
earlier step had checked:

1. `check` asserts `inputs.target != "prod"` and passes with `target=dev`.
2. `approve` is approved by someone who saw `dev`.
3. `swamp workflow resume … --input target=prod`
4. `deploy` runs against prod. Neither the check nor the approver saw that
   value.

`--last-evaluated` opens the same hole another way. It replays the evaluated
workflow cache, whose expressions were resolved when the cache was written. The
run records the inputs it was started with, which can differ. Each behavior
step then replays its definition's evaluated cache, which is keyed by behavior
name and shared by every workflow that runs the behavior. Another workflow's
run, or `model evaluate`, can rewrite it in between. One run can therefore mix
values from three evaluations: the workflow cache's, a definition cache's, and
its own.

## Why this design

Each rule can be enforced by inference or by construction.

The resume rule by inference asks, at resume time, which inputs each finished
step read. The answer comes from the workflow file, the behavior definitions,
both evaluated caches and the expression grammar. Every one of those changes
after the step ran. Where the answer cannot be told, the resume is refused, and
each refusal needs a message and a way out. By construction, the rule reads the
run record and nothing else.

The replay rule by inference asks which inputs each cache resolved into its
steps, which needs the evaluator to record what it substituted. By construction,
the run uses the cache's inputs, which the cache already records.

The definition rule by inference checks each definition cache against the run.
Replaying definitions from a per-run snapshot instead would need a new artifact,
and `workflow evaluate` cannot fill it: a definition is evaluated when its step
runs, with step outputs in scope, and `evaluate` has none. By construction, the
step evaluates its definition against inputs that already match the workflow
cache's.

Absence is where construction stops. Whether a finished step tested for an
input it did not have can only be told by reading what the step evaluated,
which is the inference above. The plan takes the limit rather than the
inference, and says so.

One fact shapes the migration. The whole workflow is evaluated at run start
(`evaluateWorkflow` in `src/domain/workflows/execution_service.ts`). A plain
read of an input the run does not have, such as `${{ inputs.authKey }}` in a
step after the gate, fails the run at start with `No such key: authKey`. So an
input supplied at resume cannot simply be left out and read plainly. It is read
in a form that tolerates its absence, and the resume's re-evaluation then
supplies the value.

## Inputs are write-once

A run keeps the value it has for each input. `checkResumeInputOverrides`
compares each supplied top-level key with `run.inputs` and reads nothing else:
not the workflow file, not definitions, not caches, not expressions, not the
resume's reset.

| Resume supplies                                                | Result                                                      |
| -------------------------------------------------------------- | ----------------------------------------------------------- |
| A key the run does not have                                    | Allowed; the run records it                                 |
| A key the run does not have, which a finished step read absent | Allowed; the limit under [Late inputs](#late-inputs)        |
| A key with the value the run already has                       | Allowed; nothing changes                                    |
| A key with a different value                                   | Refused with `resume_input_immutable`; the run is unchanged |

Values are compared after type coercion and deep merge, as today. `--input n=3`
equals a stored `3`. `cfg={"a":1}` merged over a stored `{"a":1,"b":2}` is no
change. A schema default counts as a value the run has. A `--from` retry makes
no difference: a changed value always needs a new run.

The refusal names the run id, the refused keys and the way out, never a value.
For a suspended run the way out is the cancel command, then a new run
(`suspendedWayOut` in `src/domain/workflows/resume_reset.ts`). For a failed run
it is a new run. The message stays well under serve's 512-character limit.

### Late inputs

A late input is one the run starts without and a resume supplies. It is
declared in the workflow's input schema, not `required` and with no `default`,
so the run starts without it. A step after the gate reads it in one of these
forms:

- `${{ has(inputs.authKey) ? inputs.authKey : '' }}`
- `${{ inputs.?authKey.orValue('') }}`
- inside `vault.get(...)`, which is resolved when the step runs.

Resume re-evaluates the workflow with the merged inputs, so the step sees the
supplied value.

**The limit.** A step before the gate can read a late input in the same forms
and see its absence, or a fallback. The write-once rule does not stop the
resume from then adding the input:

1. The run starts without `target`.
2. `check` evaluates `inputs.?target.orValue('dev') != "prod"` and passes.
   `approve` is approved by someone who saw `dev` in the same way.
3. `swamp workflow resume … --input target=prod` is allowed: the run had no
   `target`.
4. `deploy` runs against prod.

This is the swamp-club#3583 scenario with absence as the placeholder. Detecting
it needs to know what `check` read, which is the inference this design removes.
The plan accepts the limit and binds the pattern instead:

- **A late input that must be checked or approved gets its own check and gate
  after it arrives.** A gate suspends the run; the resume supplies the input;
  a step checks it; a second gate shows it; the second resume runs the rest.
  The input is a value the run has before the second gate, so the write-once
  rule pins it from there on.
- **A step before the input arrives does not read it.** A fallback such as
  `orValue('dev')` belongs only in a step after the gate that supplies the
  value. A step before the gate that reads the input plainly fails the run at
  start, which is the right outcome.

The documentation says both, in [workflows](../primitives/workflows.md) and the
skill references. The guard's test "a key the run did not have counts as
changed" (`src/domain/workflows/resume_input_guard_test.ts`) inverts: its
replacement asserts that the add is allowed, cites this section, and states the
scenario above so the limit is recorded in the tests and not only here.

**What stays from the branch.**

- A resume records the merged inputs it runs with, and `run.inputs` holds the
  same set (`captureInputs` in `resumeWorkflow`).
- Keys supplied at resume stay out of a child's deferred bindings, under both
  `inputs.<key>` and `run.inputs.<key>`.
- The omission of those bindings is prototype-safe
  (`src/domain/expressions/deferred_expression.ts`).
- `inputNamesRead` stays for the forEach-over-resume-input omission
  (`src/domain/expressions/cel_grammar.ts`).

**What goes away.** Per-step read inference over authored steps, jobs, workflow
fields and behavior definitions. The edited-workflow and
`replayedEvaluatedCache` fallbacks. The "counts as used" wording. The `--from`
hint search (`src/domain/workflows/resume_input_guard.ts`). The
`replayedEvaluatedCache` flag on the run record stays as recorded history; only
the inference's read of it goes.

**Doc fix.** The swamp skill's resume example passes
`--input authKey=tskey-abc123`. Resume values are written to the run record, so
the example should pass a vault key name instead
(`.claude/skills/swamp/references/workflow/reference.md`).

## A `--last-evaluated` run runs with the cache's inputs

Before the run starts:

- Each supplied `--input` is compared with the cache's recorded value, after
  coercion and merge. A differing value refuses the run, with a pointer to
  evaluate again with those inputs or run without `--last-evaluated`.
- The run records the cache's recorded inputs. A supplied input equals its
  recorded value, so the set is the same either way.
- A cache whose inputs cannot be compared is refused. Which message depends on
  why, below.

**One load.** The cache is read once per run start, and that one copy is what
the input comparison, superseding and execution all use. Today the run path
reads it for superseding and the execution service reads it again by name
(`supersedeMatchInputs` in `src/libswamp/workflows/run.ts`, and the
`findByNameWithProvenance` call in `src/domain/workflows/execution_service.ts`).
A `workflow evaluate` or fresh run in between can replace the cache after
predecessors matching the first copy were cancelled, so execution replays
another evaluation's inputs or refuses inputs the first copy accepted. The run
path loads the cache, the workflow and its metadata, checks the inputs against
it, supersedes on its recorded inputs, and hands the same object to the
execution service as a run option. Execution never reads the cache by name. The
CLI and serve paths both do this (`src/cli/commands/workflow_run.ts`,
`src/serve/deps.ts`). No new persisted artifact.

Superseding matches on the inputs the run will record, which are the loaded
cache's. A run the input comparison refuses supersedes nothing.

**When the cache recorded no inputs.** Three cases look alike today, since the
`evaluatedInputs` field is simply absent. The cache tells them apart:

| Cache                                                         | Record                             | `--last-evaluated`                                                                  |
| ------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------- |
| Evaluated with inputs, none sensitive; a workflow with none   | `evaluatedInputs`, `{}` if none    | Replays                                                                             |
| Evaluated with an input that held a sensitive value           | `evaluatedInputsOmitted: sensitive` | Refused: the inputs held a secret, so the cache cannot be replayed; run without it |
| Written before inputs were recorded                           | Neither field                      | Refused: run the workflow fresh once, which rewrites the cache                      |

`recordableEvaluatedInputs` omits the inputs on purpose when any value, nested
included, is a known sensitive value, because the cache file would carry it in
plaintext (`src/domain/workflows/persisted_workflow.ts`). A fresh run makes the
same choice, so "run fresh once" is wrong advice for that case. Such a cache is
non-replayable, and the refusal says so. No secret is written to the cache to
make it replayable. Recording a sensitive input as a vault reference, the way
`writtenReferences` records the workflow body's, would make it replayable; that
is a possible later extension and not part of this change. A parent starts its
nested child runs fresh, never with `--last-evaluated`, so this refusal only
meets a workflow that takes a secret as an input and is run directly with the
flag.

A resume of a `--last-evaluated` run is an ordinary resume. It re-evaluates the
workflow on disk with the run's inputs, as every resume does, and takes new
keys under the write-once rule.

**What goes away.** The `resolvedExpressions` recording in the evaluator and in
both evaluated caches. `inputsConflictingWithCache`,
`inputsConflictingWithCachedDefinition`, `cachedDefinitionRefusal` and
`cachedDefinitionsRefusal`. Supersede's definition-check dependency and its
own cache lookup (`src/domain/workflows/persisted_workflow.ts`,
`src/libswamp/workflows/supersede.ts`).

## A `--last-evaluated` run evaluates definitions fresh

A behavior step in a `--last-evaluated` workflow run evaluates its definition
as a fresh run does: against the run's inputs, the step's own arguments, and
the outputs of the steps before it. Those inputs equal the ones the cached
workflow was resolved with, so the step and the workflow agree. No definition
cache is read, so no other workflow's run can change what the step runs.

The definition caches are still written by fresh runs and by
`model evaluate`. `swamp behavior run --last-evaluated` keeps reading its own
behavior's cache. Only workflow runs stop reading them.

The cost is speed. The flag's purpose is to skip evaluation
([inputs](./inputs.md), Evaluated Execution). A replayed run still skips the
workflow's evaluation, forEach expansion included. It no longer skips each
definition's, and it may load the model namespace where the cached definitions
let it avoid that.

**What goes away.** The `lastEvaluated` mode of the step executor's definition
evaluation, including its secret rehydration and its de-duplication of deferred
expressions from the definition cache. The `lastEvaluated` branch of
`buildRunContext` that inspects cached definitions
(`src/domain/workflows/execution_service.ts`).

**Acceptance tests.** Two tests in swamp-uat use the flag. The
`--last-evaluated` case in `tests/cli/adversarial/cel_injection_test.ts` is a
standalone behavior run replay, which this change leaves unchanged, and it must
keep passing. The workflow case in `tests/cli/e2e/cel_evaluate_test.ts` checks
that the run completes and says nothing about whether a definition was
re-evaluated. Neither establishes the new rule, so this change adds its own test,
below.

## Verification

Beyond the unit tests of each deleted and replacing function:

- **Write-once.** Add a key: allowed. Same value: allowed. Different value:
  refused, run unchanged, message under 512 characters. A key a finished step
  read absent: allowed, with the scenario from [Late inputs](#late-inputs)
  stated in the test.
- **Late-input pattern.** A workflow with two gates: the first resume supplies
  the input, a step checks it, the second gate shows it, the second resume
  cannot change it.
- **Cache replacement.** A repository stub that returns cache A on the first
  read and cache B on any later read. A `--last-evaluated` run with inputs
  matching A supersedes the predecessors matching A and executes A's workflow
  with A's inputs; nothing reads B. A second scenario replaces the cache after
  superseding has cancelled predecessors and asserts the same.
- **Omitted inputs.** A cache written from inputs holding a sensitive value is
  refused with the non-replayable message; a legacy cache with neither field is
  refused with the run-fresh message; a cache with `{}` replays.
- **Definitions fresh.** Edit a definition's source after the fresh run and
  write a wrong value into its definition cache; a `--last-evaluated` run
  shows the edited source and never reads the cache
  (`integration/evaluated_cache_provenance_test.ts`, the cached context
  cases).
- Rerun the end-to-end scenarios and the two swamp-uat tests.

## Alternatives considered

| Alternative                                                    | What it keeps                               | Why not                                                                                                   |
| -------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Infer at resume time what each finished step read              | Overriding any input not yet read           | Reads sources that change after the step ran; every gap is a refusal that needs a message and a way out   |
| Refuse adding a key a finished step read as absent             | Protection for observed absence             | Needs the same inference: which step read what                                                            |
| Record what each step read when it ran: names and value hashes | Overriding at resume, judged precisely      | Every evaluation path has to record. One that forgets lets a change through                               |
| Snapshot the workflow, its definitions and its inputs per run  | Definition replay under `--last-evaluated`  | A new artifact; `workflow evaluate` cannot fill it: a definition may read step outputs it does not have   |
| Record sensitive inputs as vault references in the cache       | Replay of a secret-input workflow           | Cache-layer work for one case a parent never replays; a later extension if it is wanted                   |
| Refuse every resume `--input`                                  | Nothing                                     | Breaks supplying a vault key name minted during the gate                                                  |
| Warn for one release, then refuse                              | The placeholder pattern, for one release    | The hole stays open for that release                                                                      |

## Delivery

Done in one PR on the swamp-club#3583 branch:

1. Replace the resume guard with the write-once check. Delete the inference
   code and its tests. Invert the observed-absence test as described.
2. Load the evaluated cache once in the run path and pass it to execution.
   Replace the replay checks with the pre-run input comparison on that copy.
   Delete `resolvedExpressions` and the definition-cache checks.
3. Record `evaluatedInputsOmitted` when inputs are withheld for a sensitive
   value, and refuse the three no-inputs cases with their own messages.
4. Evaluate definitions fresh under `--last-evaluated`. Delete the step
   executor's replay mode.
5. Update [workflows](../primitives/workflows.md) (Resume inputs and
   `--last-evaluated`), [inputs](./inputs.md) (Evaluated Execution), the skill
   references, and the `workflow run` and `workflow resume` help text. Document
   the late-input forms, the limit, and the check-after-arrival pattern.
6. Run the verification above.

## Decisions

- The error code is `resume_input_immutable`. `resume_input_consumed` was
  added on this branch and described the inference rule, so renaming broke
  nothing released.
- The `replayedEvaluatedCache` flag on the run record stays: it is history the
  run view shows, and nothing in the rules reads it.
- The omitted-inputs marker is `evaluatedInputsOmitted: sensitive`, a literal
  with one value. A second reason, if one appears, widens the literal.
- The execution service loads the cache by name only when its caller passed
  none. Every path that supersedes (the CLI and serve, through the libswamp run)
  passes the copy it matched on; a direct in-process caller supersedes nothing,
  so loading there is safe. The loader is a required field of the supersede
  deps, so a caller cannot wire superseding without it.
- Not done: an authoring-time warning for a step that reads an optional,
  default-less input in a tolerant form and does not run after a gate. It
  would read only the authored workflow at `workflow validate` and be
  advisory. It narrows the late-input limit in practice without a guarantee,
  and is left for a later issue.
