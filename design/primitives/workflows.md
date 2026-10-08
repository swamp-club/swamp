---
audience: maintainer, operator
last-verified: 2026-10-06 @ 77141f20
---

# Workflows

A workflow defines what to execute. Each execution is a _Workflow Run_.

A workflow is made up of one or more _jobs_, and each job of one or more
_steps_. A step calls a method on a model or invokes another workflow.

Jobs can depend on each other. A job runs only if its dependency condition is
met, for example only when one of its upstream dependencies fails. Like steps,
jobs have conditions that trigger them.

Steps within a job, and jobs within the workflow, run in a weighted topological
sort for maximum parallelism. An optional `concurrency` field caps how many
steps in a topological level run at once. This helps with `forEach` expansions
that hit rate-limited APIs.

## Step Task Variants

A `model_method` step task has two mutually exclusive variants.

### Existing Definition (`modelIdOrName`)

Refers to an existing definition by name or ID:

```yaml
task:
  type: model_method
  modelIdOrName: my-vpc
  methodName: create
  inputs:
    cidr: "10.0.0.0/16"
```

### Direct Type Execution (`modelType` + `modelName`)

Creates the definition if it doesn't exist. The type's schemas decide which
inputs are global arguments and which are method arguments:

```yaml
task:
  type: model_method
  modelType: "@swamp/aws/ec2/vpc"
  modelName: my-vpc
  methodName: create
  inputs:
    region: us-east-1
    cidr: "10.0.0.0/16"
```

A step cannot have both `modelIdOrName` and `modelType`. Auto-created
definitions are stored in `.swamp/auto-definitions/`.

The optional `globalArgs` field passes global arguments directly and skips
schema-based input routing. When it is set, `inputs` are method arguments only:

```yaml
task:
  type: model_method
  modelType: "@myorg/deployer"
  modelName: my-deployer
  methodName: deploy
  globalArgs:
    region: us-east-1
  inputs:
    version: "1.0"
```

`globalArgs` is valid only with direct type execution. The schema rejects it
for `modelIdOrName` tasks.

`inputs` and `globalArgs` each accept a literal YAML record or a single CEL
expression that evaluates to a record at runtime:

```yaml
# Literal record (individual values may contain expressions)
inputs:
  host: ${{ self.host }}
  port: 443

# Whole-field expression (must evaluate to a record)
inputs: ${{ self.item.implementation.inputs }}
globalArgs: ${{ self.item.implementation.globalArgs }}
```

A whole-field expression is validated after evaluation. If it produces a
non-record value (null, array, number, string), the step fails with an error.

For `forEach` steps, `self.*` CEL template expressions resolve in the step
`name`, `inputs` and `globalArgs`, and in every task target field:
`modelIdOrName`, `modelName`, `methodName`, and (for workflow tasks)
`workflowIdOrName`:

```yaml
- name: scan-${{self.host}}
  forEach: { item: host, in: "${{ inputs.hosts }}" }
  task:
    type: model_method
    modelType: "@swamp/cve/dirtyfrag"
    modelName: fleet-scanner
    methodName: scanFleet
    inputs:
      host: ${{ self.host }}
```

A task target (`modelIdOrName`, `modelName`, `workflowIdOrName`) resolves when
its step runs, not at run start, if it reads `data.*` or `steps.*` or its step
has a `guard`. It then sees records that earlier steps in the same run wrote.
See "Task-target deferral" in
[../enablers/expressions.md](../enablers/expressions.md).

### Manual Approval (`manual_approval`)

Pauses the workflow at a step boundary and saves the run to disk. The operator
or another user approves or rejects it through the CLI. The original operator
then resumes the workflow to run the remaining steps.

```yaml
steps:
  - name: verify-ssh
    task:
      type: manual_approval
      prompt: "Verify Tailscale SSH access from your laptop before proceeding"
      timeout: 3600
```

**Fields:**

- `prompt` (required, string): message shown to the operator.
- `timeout` (optional, number): seconds. Checked at both approve and reject
  time against when the step was suspended (`evaluateApprovalTimeout` in
  `src/libswamp/workflows/approve.ts` and `reject.ts`). Once it expires,
  approve and reject are both refused and the gate is an **expired gate**: the
  run stays `suspended` and can only be cancelled.
  `swamp workflow approvals` (`src/libswamp/workflows/approvals.ts`) lists it
  in an `expired` list beside `approvals`, with the run, the step, when it
  suspended, the timeout and when it expired. It is never counted as pending.
  Log mode prints it in its own section with the command that cancels the run
  (for a run `swamp serve` started,
  `swamp workflow cancel --run <id> --server <url>`, since a local cancel
  refuses it). Through serve, the `expired` list is filtered like `approvals`:
  a row is returned only to a reader of its workflow, and a nested run's row
  names its parent only to a reader of the parent's workflow. The handler
  builds the reply from the lists it filtered, so a list added to the
  generator later is withheld until the handler filters it. An expired gate on
  a nested run leaves its parent suspended when the child is cancelled; the
  row says so.

**Lifecycle: suspend → approve → resume**

1. `swamp workflow run` executes until it reaches a `manual_approval` step,
   marks it `waiting_approval`, and sets the run to `suspended`. Parallel
   siblings already in flight run on to a terminal state (succeeded, failed,
   or skipped); the executor drains all generators at the current level before
   saving. The saved record is a consistent checkpoint: each step is
   completed, parked in `waiting_approval`, or not started.

   Before starting, `workflow run` **supersedes** suspended runs of the same
   workflow whose resolved inputs deep-equal the new run's. They are cancelled
   with reason "Superseded by new run with matching inputs", their unfinished
   work settled as any cancel settles it (see [Cancellation](#cancellation)).
   Runs with
   different inputs are separate intents and are left alone, as are
   serve-owned runs (cancel those through serve:
   `swamp workflow cancel --run <id> --server <url>`). `--no-supersede`
   opts out. The CLI exits once the new run suspends.
2. `swamp workflow approve <workflow> <step> --run <id>` marks the step
   succeeded in the saved record; nothing executes. The local command does no
   authorization. It records `decidedBy` from `$USER`/`$USERNAME`, or
   `"unknown"` (`src/libswamp/workflows/approve.ts`). Only the `--server` path
   authorizes: the `workflow.approve` handler checks the `approve` action, not
   `run`. A `run` grant implies `approve`, so existing grants keep working, and
   an `approve`-only grant can decide gates without being able to execute the
   workflow. With `--approve-requires-explicit-grant`, serve stops counting
   `run` grants, so only a grant naming `approve` can decide a gate (see
   "Actions" in `design/enablers/access-control.md`). `--run` is optional when
   only one run is suspended.
3. `swamp workflow resume <workflow> --run <id>` re-enters the executor, skips
   completed steps, and runs the pending ones. The dashboard's Resume action
   on an approved run sends the same `workflow.resume` request, with no new
   inputs (like a CLI resume without `--input`). If the workflow was edited
   while the run was suspended, in a way the resume would walk into, resume
   refuses before anything changes and says how to clear the run (see the
   [structure check](#resume-from-failed-step---from) for suspended runs).
   Approve and reject are not checked, so a gate can still be decided.

**Auto-resume.** Approve and resume are separate so that resume can take
inputs. Most gated workflows need none, so serve can continue the run itself.
When a `workflow.approve` decides the run's last gate (`allGatesDecided` on
`WorkflowApproveData`), serve launches a detached resume
(`autoResumeAfterApproval` in `src/serve/resume_launcher.ts`, which shares
`startDetachedResume` with `handleWorkflowResume`). The policy is
`Workflow.shouldAutoResume(serverDefault)` (`src/domain/workflows/workflow.ts`):

- A workflow's own `autoResume: true | false` always wins.
- Otherwise `swamp serve --auto-resume` (`SWAMP_AUTO_RESUME`, serve.yaml
  `auto-resume`; default off) applies, but **only to a workflow that declares
  no inputs**. Resume-time inputs are never declared separately, so a workflow
  with inputs may rely on the placeholder-then-resume pattern below. It must
  opt in with `autoResume: true` itself.

The resume uses the workflow name and run id the approval resolved, not the
request fields. It counts against the approver's principal for the
`ActiveRunRegistry` caps, and the run keeps its original `initiatedBy`. With
auto-resume on, an `approve` grant releases a run that was authorized when it
started; that is the point of the opt-in. The approver cannot supply inputs on
this path.

Serve audits the launch as `workflow.auto_resume`, and the approve response
carries `autoResumed: true`. If the launch is refused or the resume fails,
serve logs and audits `workflow.auto_resume_failed`, and the run stays
`suspended`, awaiting resume. The same happens if two sibling gates are
approved concurrently and neither approval sees the other. The continuation
sweep below then launches it. A launch refused
because the workflow changed shape since the run is refused before it is
registered or charged, and a manual resume is refused the same way: that run
has to be cancelled, or, when serve started it, the change reverted.

The resume that follows an approval at once needs the approval to go through
serve (the dashboard, or `swamp workflow approve --server`). A local
`swamp workflow approve` on the same repository launches nothing itself; the
continuation sweep finds the run on its next pass. That holds on a
filesystem datastore. On a synced one an approval changes the run record,
which serve does not pull after boot, so a local approval is seen only by the
instance it was made beside, or after a restart; a local signal is seen
everywhere, since outcomes are read from the control-plane store. An
approval through serve on a run that also waits for a signal launches nothing
either (`allGatesDecided` requires no signal waits); the sweep continues that
run once its waits are settled. A suspended run with every
gate decided carries the derived `awaitingResume: true`, so the run index and
`workflow.run.search` can list it.

**Continuation.** Serve also continues a suspended run nobody is about to
decide anything more on (swamp-club#3108). `decideContinuation`
(`src/domain/workflows/run_continuation.ts`) reads the run record together
with the wait outcome records: the run is suspended, no step is still
running, no gate is undecided, no step waits on a nested run, and every wait
for a signal has an outcome of any kind. `continueSettledRun`
(`src/serve/resume_launcher.ts`) then applies the same
`Workflow.shouldAutoResume` policy and launches the resume through
`startDetachedResume`. It is called from two places:

- The instance that accepts a signal calls it once the caller has its reply
  (`continueAfterSignal` in `src/serve/signal_delivery.ts`), charged to the
  signaller. When that instance has no record of the run and its datastore is
  synced, it first fetches the record. Only a record that is missing is
  fetched: a pull overwrites a local file that differs from the remote, and a
  record that is here may hold a change not pushed yet. The download is made
  under the sync gate and given 30 s (`RUN_RECORD_HYDRATE_TIMEOUT_MS`); a
  run it gives up on is left to the sweep.
- The continuation sweep (`src/serve/continuation_sweep_service.ts`) offers
  it every suspended run this instance has, at boot and then every
  `--continuation-sweep-interval` (default 30 s; `0` disables). The boot pass
  runs in the background: it reads every suspended run, and serve does not
  hold its readiness on that. The sweep is
  what retries a launch lost to a full registry, a shutdown or a crash, and
  what continues a run signalled, or on a filesystem datastore approved, by a
  local command. It is also what notices a deadline under serve
  (swamp-club#3109, see "Timing out" under Wait for Signal): a run held back
  only by a wait past its deadline has that wait settled as `timed_out` and
  continues, so the step fails with `wait_timeout` and its `failed` handlers
  run with nobody asking. On its first
  boot after an upgrade it therefore launches every run that was already
  settled and left suspended, when the workflow's policy allows.

Nothing is authorized at the launch. The stored outcome is the authorization,
as an approval is for its own auto-resume: with auto-resume on, a `signal`
grant releases the rest of a run that was authorized when it started. A wait
settled by the local `swamp workflow signal`, or as timed out, releases it
with no principal at all. No inputs can be supplied on this path, which is
why a workflow that declares inputs must opt in itself, and why
`swamp workflow validate` fails a workflow that waits for a signal, declares
inputs and leaves `autoResume` unset.

A run the launcher cannot continue stays suspended. Each reason is logged and
audited once per suspension, as `workflow.auto_resume_skipped` (the workflow
is gone, a local command left its claim behind) or
`workflow.auto_resume_failed` (the registry refused, the workflow changed
shape, the claims could not be read, the resume failed), and the next pass
tries again. A resume that finds the run no longer suspended, or its claim
held by another, lost a race to a peer or a person and is not reported.
Neither is a run whose auto-resume policy is off: left suspended is what its
owner asked for.

A suspended run with a cancelled wait is never continued. Only a run being
saved as ended cancels its waits, so a record that still says `suspended`
beside a cancelled wait is a copy from before a peer cancelled the run. No
claim marks a cancel, so the wait's outcome is what tells such a copy from a
run to resume: resuming it would fail the wait, run the steps that follow a
failure, and push over the cancelled record. The auto-resume of a parent
(`autoResumeParentAfterChild`) refuses a cancelled wait of the parent's own
for the same reason.

A resume that was launched and then failed, leaving the run suspended, is a
different case from a launch that was refused: the run is still settled, and
whatever failed is likely to fail again. Serve tries that suspension again
only after a backoff that doubles with each failure, from 30 s to 15 min, and
audits the launch and the failure once each. The backoff is kept in memory
per instance, so a restart or a change to the run's suspension starts it
over. It does not hold back a manual `swamp workflow resume`.

A claim left by a local `workflow resume` that died before saving the run is
never replaced by serve, which cannot tell a dead local command from a live
one. Where its run records are current, serve reports such a claim once it is
a minute old (`held_by_local_command`); a manual resume replaces it.

**Continuation claims.** Two serve instances on one datastore must not both
resume a run, and on a synced datastore each reads its own cached copy of the
run record, which can still say `suspended` after a peer resumed the run. The
run's lock serialises two resumes but does not refresh a copy. So every
resume of a suspended run, from serve or from `swamp workflow resume`,
creates a continuation claim inside the run's claim, in `takeOverRun`
(`src/domain/workflows/continuation_claim.ts`):

- The claim is keyed by the run and a suspension key, a digest of the run
  record's step statuses, times, wait IDs and gate decisions
  (`suspensionKeyOf`). Every host derives the same key from the same record,
  and a copy from before a resume derives the key that resume already
  claimed. A resume refused because a wait is still open or a gate undecided
  changes no step, so it is refused before the claim: a claim kept on an
  unchanged key would hold off every later resume.
- It is created once (`putIfAbsent`) in the control-plane store serve writes
  its heartbeats to, and kept until the run is deleted. A resume that is
  restored before anything ran releases it.
- A claim held by a serve instance with a live heartbeat refuses every other
  resume, manual ones included, with a message naming the instance. Serve
  writes a heartbeat only to a remote control plane, so this applies on a
  synced datastore alone: on a filesystem datastore a serve instance's claim
  always reads as dead, and the run's lock and its record, which every
  process there reads directly, are what refuse a second resume. A manual
  resume replaces any other holder. Serve replaces only a holder known to be
  dead, and only when its own run records are current: on every pass on a
  filesystem datastore, and on a synced one only in the boot pass, which
  follows the boot hydration. A replacement creates the next generation of the
  claim and never deletes the old one, so two instances that both see a dead
  holder cannot both take its place.

Serve's resume also takes the run's lock-backed claim, which only
`swamp workflow resume` took before. On a filesystem datastore that lock and
the shared run record already give a single resume; the continuation claim is
what gives it on a synced one.

Limits on a synced datastore: the sweep does not start when the boot
hydration failed, or when the datastore has no shared control-plane store
that can create a record atomically, where serve takes no claims, since a
claim on one host's disk tells its peers nothing and no claim at all leaves
two instances free to resume one run from their own copies; a run whose latest suspension only a dead instance had, or
whose claim a dead instance holds, waits until some instance restarts; and
taking over a dead holder's claim resumes from the stored record, so steps
that holder ran and never pushed run again, as they do when a person resumes
a run after a crash. A datastore whose control-plane store cannot create a
record atomically has no claims, and a resume there takes none.

A claim does not cover every copy that is behind. A peer that cancels a run
after its last wait was signalled, or ends a run that had only decided gates,
takes no claim, and wait outcomes are written once, so this instance's copy
still reads as suspended and settled. Before serve continues a run by itself
on a synced datastore it therefore compares its record of the run with the
remote one, byte for byte (`RunRecordCurrency`, built by
`runRecordCurrencyOver` over the sync service's `fetchContent`, which reads
the remote file without replacing the cached one). `continueSettledRun` looks
once before it registers the run, and the resume looks again under the run's
lock-backed claim (`requireCurrentRecord`), which is what decides. A record
that differs is left alone without an event, like a claimed one, and looked
at again after ten minutes; that includes a record with a change this
instance has not pushed yet. A remote that cannot be read leaves the run
suspended with one `workflow.auto_resume_failed` event
(`run_record_unreadable`). The comparison covers the continuation of a
settled run, by a signal or by the sweep. The auto-resume after an approval
is not compared, since the approval it follows is a change this instance has
not pushed yet, and neither is the auto-resume of a parent. A peer's
change that is saved and not yet pushed is not seen.

A repository that keeps its run records out of the datastore
(`runsLiveInDatastore`) has one copy of each and is not compared. A sync
service without `fetchContent` gives serve nothing to compare with
(`@swamp/s3-datastore` and `@swamp/gcs-datastore` have it from
`2026.10.07.1`).
There the sweep runs its boot pass, which follows the boot hydration, and no
later one (`bootPassOnly`): a lost launch, or a run signalled by a local
command, then waits for a restart or a manual resume. A signal that arrives
at the instance is still continued at once.

A run suspended by `swamp workflow recover` is never continued. Recovery
marks the run record (`recovered: true`, `WorkflowRun.awaitsResumeAfterRecovery`)
and `continueSettledRun` leaves a marked run alone without a word: the steps
recovery reset had an unknown outcome, and no signal or approval released
them, whatever gate was decided earlier in the run. Any resume clears the
mark, so a later suspension of the same run is continued as usual. A run
recovered by a build without the mark has none. The auto-resume after an
approval and of a parent do not read the mark.

On a synced datastore every copy of a run a peer resumed stays `suspended`
on this instance until it restarts, and their number only grows. Serve
remembers a suspension it found held by another and looks at it again every
ten minutes, not on every pass, since each look reads the datastore.

Every resume serve starts by itself takes its claim as an automatic one, the
auto-resume after an approval and the resume of a parent included: none of
them replaces the claim of a holder it cannot prove dead. A serve holder is
dead once its heartbeat is older than its own `--stale-ttl`, which it
publishes in the heartbeat so that a peer or a local command with other
settings judges it the same way.

Serve registers the resume before it saves the run as `running`, so a search
right after an approval can still list the run as suspended and awaiting
resume. The dashboard therefore takes "serve is driving this run" from the
health stream's active runs, not from the approval that started it
(swamp-club#3005). A run listed there shows as being resumed, with no Resume
action, whoever approved it. A view refetches its runs when a run starts or
stops, or while a run serve drives still reads suspended. Without a health
snapshot, only an approval made in the same view (its `autoResumed: true`)
hides Resume.

`swamp workflow reject <workflow> <step> --run <id>` marks the step and the run
as failed. No resume is needed. Before the run is marked failed, the work the
rejection leaves unfinished is settled as a cancel settles it (see
[Cancellation](#cancellation)): every other waiting gate fails with error
`cancelled`, pending steps are skipped or fail as `cancelled`, and their jobs
end, so the failed record holds no job `running` and no step
`waiting_approval` (swamp-club#2905). As on a cancel, a step with a `guard`
whose `dependsOn` is met stays `pending`, and its job stays `pending` or ends
`unknown`: its guard never decided.
The run still reports the rejected gate
as its failed step. `swamp workflow resume <workflow> --run <id> --from <gate>`
reopens that settled work along with the rejected gate: each gate asks again,
with its approval `timeout` counted from the new wait.

**Gates inside a nested workflow (swamp-club#2736).** A workflow step runs its
child workflow as a run of its own. When the child suspends at a gate, the
parent suspends too: `runWorkflowStep` keeps the child's `suspended` event out
of the parent's stream, as it does the child's `completed` and `cancelled`,
and parks the parent's step in `waiting_approval` with a `nestedRun` link to
the child (`StepRun.waitForNestedRun`). The child records the step that
started it as `parentRun`, with its nesting depth and the names of the
workflows above it, so a resume of the child keeps the depth limit and cycle
detection. Every child records `parentRun` when it starts; the parent's step
records `nestedRun` only once its child suspends, so the parent of a nested
workflow without gates is unchanged, and an interrupted parent recovers as
before. Both links are validated from both ends before they are followed
(`NestedRunLink` in `src/domain/workflows/nested_run_link.ts`); a malformed
link is kept as written and never followed. The parent emits its own
`suspended` event, naming the step and, in `nested`, the child run. The
child's `approval_requested` event still reaches the parent's stream, and
carries the child's workflow name, so its approve hint names the child. In
`--json` output the suspended document's `approvalRequired` names the gate to
decide with its `workflowName` and `runId`: the gate the child, or a run below
it, requested in the same stream. When the stream carried none (a resume that
found the child suspended again), it names the waiting step of the parent.
`waitingOnNestedRun` names the child the step waits on. A direct gate's
`approvalRequired` names its own run the same way.

The child stays an ordinary suspended run. It is approved, rejected, resumed
and cancelled on its own run, with today's commands and authorization:

1. `swamp workflow approve <child> <gate> --run <child-run>`, then
   `swamp workflow resume <child> --run <child-run>`.
2. `swamp workflow resume <parent> --run <parent-run>`.

Nothing writes the parent while this happens. Whether the parent can resume is
derived from the child. `findWaitingApprovalStep` reports gates only, and a
nested wait keeps the persisted `awaitingResume` false. `workflow.run.search`,
`workflow history get` and the dashboard derive it from the child runs instead
(`nestedWaits`, and `awaitingResume` once every child finished). A parent
resume, from any entry (CLI, serve, auto-resume, and serve's recover, which
resumes), first checks every nested wait and refuses, changing nothing, while a
child has not finished
(`NestedRunPendingError`, naming what settles each child: approve, resume,
recover, or cancel). `swamp workflow recover` never resumes: it resets an
interrupted parent to suspended, and the resume that follows is refused until
the children finished. Once the children finished, the resume re-enters the
nested step without evaluating its trigger or guard again and reads the
child's outcome (`settleNestedWait`):

- succeeded: the step adopts the child's outputs. The step output records the
  key names of any inputs the child's resume was given, and the adoption is
  logged. Who could resume or retry the child is governed by the child
  workflow's own authorization; nesting it accepts that.
- failed on a rejected gate: the step fails as a rejected approval, so a plain
  retry of the parent refuses it, as it does a direct gate.
- any other failure, cancelled, missing, or a broken link: the step fails.
- running again (resumed or retried since the check): the parent suspends on
  it again.

Rejecting the child therefore needs a parent resume to take effect. In serve,
once a child's resume or reject ends, the parent is resumed for the same
caller (`autoResumeParentAfterChild` in `src/serve/resume_launcher.ts`) when
the parent waits on that exact child and no other, has no gate of its own or
step still running, every wait for a signal of its own has an outcome, its
workflow's auto-resume policy is on, and the caller still holds a grant on
the parent: `approve` when the child was continued by an approval, `signal`
when it was continued by a signal (swamp-club#3108). The continuation sweep
never resumes a parent that waits on a nested run, since it has no caller to
decide that grant for, so a child the sweep continued leaves its parent to be
resumed by hand, and serve logs the command when that child ends. That grant is decided again,
with no socket, from the caller's server-token record as of the last
membership refresh (`decideSubjectAccess` in `src/serve/handlers/shared.ts`).
A parent this instance still drives is awaited first. Each skip is audited as
`workflow.auto_resume_skipped`; no auto-resume starts once shutdown began.

When a parent ends while a step still waits on a child (a reject of its own
gate, a cancel, a supersede), only the parent changes: `cancelAndSettle`
and `completeAndSettle` mark each such step failed with `detachedNestedRun`, and the
child is left as it was. The step's error names the child but not its state,
which may have changed since the parent last read it. The command reports each
detached child that has not finished with the command that cancels it (the
`--server` form when serve owns it; `detachedNestedRunsOf` in
`src/libswamp/workflows/nested_runs.ts`). A child that already finished, or no
longer exists, needs no cancel and is not reported; one that cannot be read is
reported. `swamp workflow approvals` marks the child's row as no longer
awaited.
Cancelling the children with their parent is swamp-club#2867. Supersede skips
runs that have a `parentRun`. Run cleanup keeps a finished child while its
parent exists and has not finished (an interrupted parent still counts).
A child inherits its parent's serve instance id and `initiatedBy`, so its
cancel is routed as its parent's is, and its `run.initiatedBy` names the
parent's initiator.

Older binaries drop `nestedRun` and `parentRun` when they save a run, and see
a nested wait as a gate: approving it there would succeed the step without the
child's outputs. An older binary that approves or resumes the child saves it
without `parentRun`. `NestedRunLink.resolveChild` still accepts a child with no
`parentRun` at all when the fields such a save keeps agree with the waiting
step: no trigger source of its own, the parent's `initiatedBy`, and a start no
earlier than the step's. The parent's resume logs that it read the child this
way. A malformed or mismatched `parentRun` is never accepted. Serve does not
auto-resume a parent from such a child, since the child no longer names it:
resume the parent yourself.

`swamp workflow approvals` lists suspended runs awaiting approval, one row per
run, leaving out runs whose gate timed out. Each row names the first waiting
gate (`findWaitingApprovalStep` in `src/domain/workflows/workflow_run.ts`) and
shows the run id, suspended-at time, inputs digest, and ready-to-run
`--run <id>` approve/reject/resume commands. It supports `--server` /
`SWAMP_SERVE_URL` / `SWAMP_SERVER_URL` through the read-only
`workflow.approvals` wire-protocol endpoint (`read` authorization verb).

**Programmatic gate control (not wired):** `MethodContext` declares
`context.approveWorkflowGate()` / `context.rejectWorkflowGate()`, but nothing in
production builds the `WorkflowGateService` behind them.
`createWorkflowGateService` (`src/libswamp/models/workflow_gate.ts`) is called
only from tests. `src/libswamp/workflows/run.ts` leaves it unwired on purpose,
because model code bypasses authorization. On a remote worker both return
`{ ok: false }` (`src/worker/remote_method_context.ts`). Use the CLI or the
`workflow.approve` / `workflow.reject` WebSocket requests instead.

**Resume inputs (`--input`):** `swamp workflow resume` accepts `--input`,
`--input-file`, and `--stdin`, parsed as in `swamp workflow run`. They supply
values not available at the original run, such as environment overrides or the
vault key name of a credential minted during the gate. As on a run, each
supplied value is coerced to its declared input type, and its value merged over
the stored inputs is checked against the workflow's input schema; a mismatch
is refused before the run changes (`coerceResumeInputs` in
`src/domain/workflows/execution_service.ts`). The local CLI reports the refusal
as `input_validation_failed`; serve reports every resume error as
`workflow_resume_failed`. Resume inputs are deep-merged
over the inputs captured at suspension (`deepMerge`): existing keys stay,
nested records merge key by key, and the resume `--input` wins on a collision.
The merged set is on the expression context before evaluation, so post-gate
`inputs.*` expressions see the new values.

Evaluation stays strict: a workflow must declare at run time every input it
references. The pattern is to declare the input at run time and supply or
override its value at resume. For audit, the run record's `resumeInputs` lists
the key names supplied at resume.

Resume inputs are ordinary inputs once merged. Their values are substituted and
persisted wherever run inputs are: evaluated definitions, step data of models
that record their arguments, the run record on a later suspension, and child
runs they are forwarded to. They are not a secret channel. A credential minted
during a gate is stored with `swamp vault put` while the run is suspended, and
the post-gate step reads it with `vault.get(...)`, which is resolved per step,
redacted in step data, and left raw in evaluated definitions. Resume passes at
most the vault key name (swamp-club#2585).

**Input persistence:** A run's effective inputs are captured on the run record
at run start (`run.captureInputs` in
`src/domain/workflows/execution_service.ts`, saved by the first `saveRun`) and
again at suspension. Every run's `inputs` block is on disk, so post-gate steps
can resolve `inputs.*` on resume.

**Execution report:** `swamp workflow history get --json` shows who approved or
rejected, when, and why a rejection was made. The step view has an `approval`
block with `status` (`approved` | `rejected` | `timed_out`), actor identity,
timestamp, and optional reason (`ApprovalView` in
`src/libswamp/workflows/workflow_run_view.ts`).

**Persistence:** The run record survives process restarts. Approve and resume
can happen from any machine with access to the repo (or a synced datastore).

**forEach compatibility:** A `forEach` expansion of a `manual_approval` step
creates N parallel gates, each approved by its expanded step name. `resume()`
refuses to start while any step is still `waiting_approval`
(`src/domain/workflows/execution_service.ts`), so all N must be decided first.

### Wait for Signal (`wait_for_signal`)

Pauses the workflow until a small JSON message arrives or a deadline passes. The
message becomes the step's output, so later steps branch on it with ordinary
guards. A `manual_approval` gate answers yes or no; a wait carries a value.

```yaml
jobs:
  - name: release
    steps:
      - name: review
        allowFailure: true
        task:
          type: wait_for_signal
          timeout: 86400
          schema:
            type: object
            additionalProperties: false
            required: [verdict]
            properties:
              verdict:
                type: string
                enum: [ship, fix, abandon]
      - name: ship
        dependsOn:
          - step: review
            condition: { type: succeeded }
        # A guard skips the step when it is truthy:
        # skip unless the verdict is ship.
        guard: ${{ steps.review.outputs.payload.verdict != "ship" }}
        task:
          type: model_method
          modelIdOrName: release
          methodName: deploy
      - name: escalate
        dependsOn:
          - step: review
            condition: { type: failed }
        task:
          type: model_method
          modelIdOrName: release
          methodName: escalate
```

```sh
swamp workflow run release              # runs to the wait, prints the wait ID, exits suspended
swamp workflow waits                    # lists waits: ID, workflow, step, deadline, schema
swamp workflow signal <waitId> --payload '{"verdict":"ship"}'
swamp workflow resume release           # continues the run
```

**Task fields** (`src/domain/workflows/step_task.ts`):

- `timeout` (required): seconds the wait stays open, at most 31536000 (one
  year). A wait never stays open forever. `swamp serve` can lower the maximum
  for the waits it opens (`--max-signal-wait-timeout`, see "Timing out").
- `schema` (required): the payload schema, checked by the same
  `InputValidationService` as workflow `inputs`
  (`src/domain/inputs/input_validation_service.ts`). It must declare
  `type: object` or `properties`: the flat form that `inputs` also accepts (a
  bare map of properties) is refused when the workflow is parsed, because it is
  ambiguous with the schema's own keywords. `type: object` alone accepts any
  object.
- The schema may use only keywords a payload is checked against: `type`,
  `enum`, `required`, `properties`, `additionalProperties`, `items`,
  `minItems`, `maxItems` and `uniqueItems`, plus the annotations `description`,
  `title`, `examples` and `$comment`. Any other keyword (`pattern`, `minimum`,
  `format`, `oneOf`, ...) is refused when the workflow is parsed. So is
  `default`, which is never applied to a payload; an empty `enum`, which the
  validator skips; and an object or array keyword on a nested schema that does
  not declare `type: object` or `type: array`, which the validator would not
  read
  (`unenforcedSchemaKeywords` in `src/domain/workflows/signal_wait.ts`). A
  payload comes from outside the workflow, so a schema never promises a check
  that is not made. `additionalProperties: false` closes an object at any
  depth, whether or not it declares `properties`. Workflow `inputs` keep accepting and ignoring such
  keywords.
- The schema may read `inputs.*`, which is resolved before the wait captures
  it. It may not read `self`, `steps`, `data`, `env` or `vault`: those are not
  resolved in a schema and would be compared with payloads as literal text.
  `workflow validate` refuses such a schema, and a step that reaches its wait
  with an expression still in its schema fails instead of opening a wait no
  payload could satisfy.

**Terms.** A _wait_ is one pause of one step for one message. Its _wait ID_ is a
random UUID issued when the step starts waiting. A _signal_ is the message
delivered to a wait. The _receipt_ is what swamp records about the signal. The
_deadline_ is when the wait stops accepting one. A wait's _registration_ is the
record that says where it lives and what it accepts. Its _outcome_ is how it was
settled: an accepted signal, `timed_out` or `cancelled`. These are distinct from
an approval gate and its `waiting_approval` status.

**The wait is state on the step, and its outcome is a record of its own.**
`WorkflowRun` stays the aggregate root and the run record stays the only source
for history and `steps.*`. `SignalWait` (`src/domain/workflows/signal_wait.ts`)
is a value object on the step holding the wait ID, the schema captured when the
step started waiting, the deadline and, once a signal was applied, the receipt.
The schema is captured, so a later edit to the workflow file does not change
what an open wait accepts.

Two write-once records live outside the run record, in the datastore's
control-plane store (`src/domain/workflows/signal_wait_records.ts`):

| Key                      | Written by                                     | Content                                                                    |
| ------------------------ | ---------------------------------------------- | -------------------------------------------------------------------------- |
| `waits/<waitId>`         | The executor, before the step is marked waiting | Workflow, run, job, step, deadline, captured schema                        |
| `wait-outcomes/<waitId>` | Whoever settles the wait first                 | An accepted signal (receipt and payload), `timed_out`, or `cancelled`      |

A signal, a timeout and a cancel each try to create the same outcome key with
`putIfAbsent`, and exactly one succeeds. Every later attempt reads what is
stored and answers from it. The run record changes only inside a resume, which
holds the run's claim and applies the stored outcome to the step. So delivering
a signal never races a save of the run: it is safe while the process that
started the run still saves it, and from any host on the datastore.

`SignalWaitStore` (`src/domain/workflows/signal_wait_store.ts`) is the port for
the two families; `ControlPlaneSignalWaitStore`
(`src/infrastructure/persistence/control_plane_signal_wait_store.ts`) implements
it. `settle` creates the outcome and then reads the key back, and the caller
learns whether it won by comparing the stored outcome with its own, never from
the create's answer: a retried conditional write whose first reply was lost
reports the key as taken to the writer that took it. Both records are plaintext
in a store other writers can reach, so each is parsed on every read; one that
does not parse reads as unreadable, never as absent. Registrations larger than
256 KiB of encoded JSON are rejected before writing or suspending the step, so
every registration written fits the read limit.

The transitions live on `StepRun` (`src/domain/workflows/workflow_run.ts`):

- `waitForSignal(wait)` parks the step in the `waiting_signal` status.
- `applyWaitOutcome(outcome)` is the only way a wait ends: an accepted signal
  succeeds the step with the payload and receipt, `timed_out` fails it with
  error `wait_timeout`, `cancelled` fails it with error `cancelled`. The payload
  is checked again against the schema the step captured before it is kept; an
  outcome of another wait, or one whose payload the wait would have refused,
  changes nothing. An outcome that names another run, or whose payload does not
  survive parsing unchanged (a reserved key such as `__proto__` is dropped by
  it), reads as unreadable and fails the step.
- `failUnreadableWait()` fails a waiting step whose stored wait cannot be read
  with error `wait_unreadable`. The wait is parsed leniently so a hand-edited
  record never makes a run unloadable; such a step has no ID to signal and no
  deadline to pass, so a resume fails it and logs a warning.
- `failUnusableOutcome()` fails a waiting step with `wait_unreadable` when its
  outcome cannot be read or applied. The outcome is written once, so nothing
  would settle that wait another way.
- `cancelOpenWait()` fails the step with error `cancelled` when the run ends.
- `resetToPending()` clears the wait, so a retry gets a new wait ID. The old
  wait is closed first, so a signal for the old attempt is answered, not
  accepted.

What a wait accepts is decided by `decideSignal`, a pure function over the
registration, so the rule is in one place and needs no run record.

**The `waiting_signal` status.** A waiting step does not reuse
`waiting_approval`. An older binary would list the wait as an approval gate, and
approving it would succeed the step with no payload. A status the older binary
does not know makes it refuse the run instead. swamp-club#3068 stored such a
step as `waiting`. A binary of that build writes the run record directly and
never reads an outcome record, so it would time out a wait whose signal had been
accepted, or settle one without closing it. Waits opened since therefore use
`waiting_signal`, which that build cannot parse. `isSignalWait` is true for
both statuses, a run suspended by the earlier build is handled by the same code,
and every view shows the step as `waiting`, so command output is unchanged. The
kind of wait is recorded beside the status (`wait.kind: signal`), which leaves
room for other kinds of wait. `isUnfinishedStatus`
(`src/domain/workflows/trigger_condition.ts`) is the one predicate for "this
step has not reached an outcome"; code that only needs to know that uses it
rather than naming the statuses.

The cost of the new status is accepted and is wider than the one run: see
"Mixing builds" below.

**Which datastores support a wait.** Wait records must be visible to every
process that can settle the wait, so `resolveSignalWaitSupport`
(`src/cli/repo_context.ts`) keeps them with the datastore and never under the
repository:

| Datastore                                                             | Wait records                                                                 |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| filesystem (the default, or a custom path)                            | `<datastore path>/_control/`, below the namespace when one is set            |
| custom, with the `controlPlane` capability and a store with `putIfAbsent` | The extension's control-plane store                                       |
| any other custom datastore                                            | Not supported                                                                |

Starting a run of a workflow that contains a `wait_for_signal` step is refused
on an unsupported datastore, before anything runs, with a message naming the
datastore type. A store local to one machine would accept a signal the run's own
host never sees, which is worse than a refusal. A wait inside a nested workflow
is refused when the child run starts. `swamp serve` keeps its other
control-plane records where they were; only wait records follow this rule.

The extension's store is opened on first use, not when a command starts
(`lazyRemoteStore`). The S3 and GCS extensions bind their namespace for good on
the first sync or control-plane call, and older versions fix the store's list
prefix when it is created, so a store made before a namespaced pull would list
under the wrong prefix. Every command builds a repository context; only one
that uses a wait binds the namespace with a pull, as
`initializeControlPlaneVaultForCli` does, and then creates the store. Whether
the store has `putIfAbsent` is known only then, so a workflow with a wait opens
it before it starts, on a new run and on a resume alike, and is refused if it
has not. A failure to open for another reason, such as the network, is passed
on as it is. Serve has bound the namespace
at boot and skips the pull. A failed open is tried again by the next call.

A run already waiting on a datastore that cannot hold wait records, suspended
there by swamp-club#3068, cannot be signalled. Its resume is refused, saying so,
while the wait is open, and past the deadline fails the step with
`wait_timeout` so `failed` handlers run; cancel also ends it.

**Signalling.** `swamp workflow signal <waitId> --payload '<json>'`
(`src/libswamp/workflows/signal.ts`) reads the wait's registration, decides the
payload against it, and creates the outcome. It takes no run claim, asks nothing
of the run's owner and never writes a run record
(`integration/signal_wait_records_rules_test.ts` holds it to that). A signal
names the wait ID and nothing else: step names are unique only within a job and
`forEach` expands one step into many, so a name does not identify a wait. The ID
must be a UUID before a key is built from it. Each refusal has its own message:

| Refusal           | When                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- |
| not found         | No registration, outcome or run record holds a wait with that ID.                                                    |
| expired           | The deadline has passed. The wait is settled as `timed_out` on the spot; the message names the resume that fails the step. |
| payload refused   | The payload is not allowed. The validation errors are listed and the wait stays open.                                |
| already settled   | A signal already settled the wait. The stored receipt is shown.                                                      |
| closed            | The run ended, or its step was reset, before a signal arrived.                                                       |
| cannot be read    | The outcome does not parse, the registration does not and no run record here can rebuild it, or the run record here shows the step holding an unreadable wait. |
| not supported     | The datastore cannot hold wait records.                                                                              |

A signal that loses the create to a timeout, a cancel or another signal gets
the refusal for what is stored. The result reports `awaitingResume`, read from
the run record as this host has it together with the outcomes of the run's other
waits. On a host that has no copy of the run it cannot be known: it is reported
`false` with `runRecordAvailable: false`, and the log output says so instead of
claiming the run still waits on something else.

**Through `swamp serve`.** A signal can also be delivered to a server, with
`swamp workflow signal --server`, the WebSocket request `workflow.signal`, or
`POST /api/v1/signal/<waitId>` (swamp-club#3094). It is the same use case behind
an authorization boundary: the caller needs the `signal` action on the wait's
workflow, an unknown wait and a wait the caller may not signal are answered
alike, and the workflow, run and step are named only to a caller who may also
read the workflow. The use case takes an `authorize` callback for this, asked
once the wait is placed and before anything is stored or said, and each refusal
carries a machine-readable kind so the server maps it without reading the
message. Serve turns off the run-record fallback described below
(`scanRunRecords: false`). The routes, the answers and their status codes are in
[serve](serve.md) under "Signal"; the action is in
[access-control](../enablers/access-control.md).

A signal does not change what the run record says. Until the run is resumed its
step still shows `waiting`, the record's derived `awaitingResume` is unset, and
`workflow run` keeps the run instead of superseding it. `workflow waits` and the
signal's own result are where a settled wait shows. Serve resumes the run
itself once its last wait is settled, when the workflow's auto-resume policy
allows (see "Continuation" under Manual Approval).

**A wait with no usable registration.** When the registration is missing or
cannot be read, `workflow signal` falls back to scanning run records and
rebuilds it from the step that holds the wait (`ensureRegistered`);
`workflow waits` does the same for every such wait it meets. The run record
holds the whole wait, so a damaged registration file does not leave a wait
nothing can signal. This is also how a run suspended by swamp-club#3068, which
never registered its waits, takes a signal. A resume needs no registration: it
reads the outcome by the ID on the step.

**A step that registered a wait and never saved it.** A process killed between
registering a wait and saving the run leaves a registration the run record does
not know. `workflow waits` lists it and a signal for it is accepted. When the
step runs again, after `workflow recover` or a resume, it takes that wait over
instead of opening another (`adoptableWait` in
`src/domain/workflows/execution_service.ts`; only a run taken up again looks,
since the search reads every registration), so the accepted signal is applied
by the next resume. A wait that passed its deadline unsignalled is closed
instead and the step opens a new one, as a retry does.

**Mixing builds.** A binary from swamp-club#3068 cannot parse a run that holds
a `waiting_signal` step. While one such run exists in a repository or on a
shared datastore, that binary fails with a schema error, not a message naming
the cause, on:

- every command for that run and its workflow (`history`, `resume`, `cancel`,
  and `run` unless `--no-supersede` is given);
- the commands that read every run: `workflow approvals`,
  `workflow cancel --all`, `workflow waits` and `workflow signal`, for every
  workflow, also through an older `swamp serve`.

Its commands for other workflows by name, and its serve, keep working, and it
changes nothing in the run. This reaches people who do not use waits when they
share a repository with someone who does, so every host must be upgraded before
the first workflow with a wait is run. It was chosen over keeping the `waiting`
status, with which the older binary would read these runs and silently discard
accepted signals.

A binary from before swamp-club#3108 resumes a run without creating its
continuation claim. On a synced datastore, a serve instance on a newer build
whose cached copy of that run still says `suspended` then finds no claim and
resumes it again. Upgrade every host that resumes runs on a shared synced
datastore, serve instances and local commands alike, before relying on the
continuation sweep there, or keep it off with `--continuation-sweep-interval 0`
until they are.

The `signal` access action (swamp-club#3094) has a mixed-build hazard of its
own: a build from before it drops any stored grant that names `signal`,
including a deny. See "Actions" in
[access-control](../enablers/access-control.md).

A run suspended by that build itself still has the status `waiting`, and that
binary still acts on it by writing the run record: its `workflow resume` does
not see a signal accepted as an outcome and past the deadline fails the step
with `wait_timeout`, and its `workflow signal` and `workflow cancel` settle the
step and leave the registration open. A later signal from this build finds the
step already past its wait in the run record on this host and is answered from
that record ("already settled" with its receipt, or "closed") instead of being
accepted.

Every refusal names the wait ID exactly as it was typed, and none names the
person who sent an earlier signal. Telemetry records the first line of an error
with the typed arguments removed, so the ID never reaches it; the receipt of an
already settled wait is in the error's details, not its message.

**The payload is untrusted.** It comes from outside the process, is stored in
plaintext in the outcome record and then the run record, and is later read by
guards. Before anything is stored
`SignalWait.validatePayload` requires, whatever the schema allows:

- a JSON object, no larger than 16 KiB serialised;
- no key named `__proto__`, `constructor` or `prototype` at any depth (the
  reserved keys), with the refusal naming the key;
- nesting no deeper than 16 levels;
- validity under the captured schema.

The stored payload is exactly what was sent. Schema defaults are never applied
to it, nothing is coerced, and no key is added or dropped: a payload is stored
unchanged or refused. A `null` value is refused for every property the schema
declares, and for an array item whose `items` schema is declared: only a
property with a default accepts one, and a wait schema may not declare a
default. A key the schema does not declare but allows, such as any key under
a bare `type: object`, is not checked and may hold `null`, as it may hold
anything else. The payload must not carry secrets.

**Output.** The step's outputs are:

```text
steps.review.outputs = {
  payload: { verdict: "ship" },
  signal: { id, waitId, receivedAt, submittedBy }
}
```

`signal` is written by swamp, never by the sender. `submittedBy` is the OS user,
as `decidedBy` is for a local approve. The step's stored `output` carries
`type: wait_for_signal` beside them, and `StepOutputResolver`
(`src/domain/workflows/step_output_resolver.ts`) restores the outputs on resume
without reading the datastore.

**Resuming.** `workflow resume` is the one writer of a suspended run. Under the
run's claim, `takeOverRun` reads the outcome of every waiting step
(`applyAcceptedSignals` in `src/domain/workflows/signal_wait_cleanup.ts`),
succeeds each step whose signal was accepted, and refuses while any wait has no
outcome, as it does for an undecided gate, naming the signal command. Otherwise
it continues, with the payload restored into `steps.<name>.outputs`. If the
resume fails before execution starts the run is restored as it was; the outcome
is still stored, so the next resume applies it again.

A resume is refused while the process that suspended the run is still running
the level it suspended in (`suspendedRunOwnerStillRuns` in
`src/domain/workflows/orphaned_run_reaper.ts`). That owner saves the record as
`suspended` before the level drains and keeps saving it from memory, without
the claim, until its last step finishes; a resume that took the run over then
would be saved over, and two processes would drive one run. The run tracker
shows it: the owner marks its row `suspended` only after its last save. The
refusal applies to every suspended run, one suspended on an approval gate
included. It is made only for a tracker row owned on this host with a live pid.
An owner killed mid-level does not refuse; the resume runs its abandoned step
again. An owner on another host cannot be checked and is not refused, which
leaves that case open. `swamp serve` does not make this check: a run it is
still executing is reserved in its active-run registry.

The owner's saves also overwrite an approval or rejection made in that window,
which was true before this check existed. So the refusal tells the user to
check the run once the owner has finished and give the decision again if it was
not kept; resuming straight after the owner exits can otherwise answer "still
awaiting approval".

**Timing out.** A deadline is enforced lazily, by whoever looks: `workflow
signal`, `workflow waits` and `workflow resume` each settle a wait as
`timed_out` when it has no outcome and its deadline has passed (`outcomeAt`).
The create decides between that and a signal arriving at the same moment, so
every reader agrees whatever its clock says, and a signal accepted before the
deadline still holds after it. The next resume fails the step with error
`wait_timeout`, so `failed` handlers run. `allowFailure` decides whether that
fails the job and the run.

Under `swamp serve` the continuation sweep is one more reader that looks
(swamp-club#3109). When `continueSettledRun` finds a run held back only by
its waits (`wait_unsettled`: no step running, no gate undecided, no nested
wait), `settleExpiredWaits` (`src/domain/workflows/signal_wait_cleanup.ts`)
settles each wait that is past its deadline, has no outcome and is still
registered, and the run then continues as a signalled one does: same
auto-resume policy, claim, record comparison and backoff. The resume fails
the step. The deadline is absolute; how soon after it the handlers run
depends on serve being up and on the sweep interval, and a wait that expired
while no instance ran is settled by the first pass after boot. The
`workflow.auto_resume` audit event carries `waitsTimedOut=<n>` when the pass
that launched the resume settled waits. What the sweep does not do:

- It follows the auto-resume policy. A workflow serve may not resume keeps
  its expired wait unsettled and its run suspended, as it keeps a signalled
  run suspended.
- It settles only a wait whose registration can be read. A registration is
  removed when its run ends or is deleted, so a suspended copy of such a run
  is behind, and an outcome created for it would outlive the run. A wait
  with no registration (see the limits below) is still settled by a resume.
- Where the sweep does not start, or runs only its boot pass (see
  "Continuation claims"), a deadline that passes after boot is noticed as
  before: by the next signal, listing or resume.
- A nested run whose wait timed out fails, and its parent stays suspended
  until a manual resume, as after any child the sweep continued.
- An approval gate past its timeout is not failed by the sweep. It stays
  suspended until an approve, a reject or a listing looks.
- Every instance reads the deadline against its own clock and the first
  create wins. An instance whose clock runs ahead closes a wait early for
  every reader, so serve hosts need synchronised clocks. There is no
  allowance for skew.

**Maximum timeout.** The task schema allows a `timeout` of up to one year.
`swamp serve --max-signal-wait-timeout <duration>` (env
`SWAMP_MAX_SIGNAL_WAIT_TIMEOUT`, at most one year) lowers that for the waits
this server opens. It is carried on the wait support serve gives its
executors (`SignalWaitSupport.maxTimeoutSeconds`) and enforced when a step
would open its wait, not when the workflow is validated: validation runs in
the local command, which has no server configuration. A step that asks for
more fails with a message naming both values, so `allowFailure` and `failed`
handlers apply. A wait already open, or taken over from an earlier
registration, keeps its deadline whatever the maximum is now.

A step that holds a wait re-enters the walk as a
nested wait does: its `dependsOn`, its `guard` and its start are not evaluated
again, because a guard that reads resume-time inputs could otherwise turn the
timeout into a skip, and starting the step again would open a second wait. A
waiting `forEach` iteration that the resume's collection no longer produces is
not walked, so it is settled when its job ends: it fails with `wait_timeout`
(or `wait_unreadable`) under the same `allowFailure` rule.

**Listing.** `swamp workflow waits` (`src/libswamp/workflows/waits.ts`) lists
the registered waits nothing has answered, soonest deadline first, with the wait
ID, workflow, run, job, step, deadline and schema. A registration is enough: a
wait is listed even when its run record has not reached this host. A wait past
its deadline is settled as timed out and listed with `expired: true` and the
resume command, so the run that needs a resume can be found. A wait a signal
settled is not listed. A waiting step whose stored wait cannot be read, or
whose outcome cannot, is listed apart, in `unreadableWaits`, with the resume
that fails it. The printed commands carry `--repo-dir` when the command was
given one. The command also registers waits of runs suspended before waits were
registered, and sweeps (see below), so it is not read-only.

Asked with `includeSignalled` (an option of the `workflowWaits` use case and of
serve's `workflow.waits` request; the CLI does not pass it), the listing also
returns `signalled`: each wait a signal has settled whose step still waits for
the resume that applies it, with the receipt, the resume command and
`awaitingResume`, which is true when nothing else holds the run back. A wait a
resume has applied is not listed, though its registration stays until the run
ends. A run or sibling wait that cannot be read lists the wait as not ready to
resume. The dashboard asks for it.

Through serve, `workflow.waits` and `swamp workflow waits --server` run the same
listing for a caller with `read` and show the waits of the workflows that caller
may read. It writes as the local listing does, for every workflow and not only
those shown: it registers unregistered waits, settles overdue ones as timed out
and sweeps. That is a write behind a read grant, accepted because each write
depends only on stored state, never on the request, and because the listing is
what makes a wait of an older run reachable by a signal through serve, which
does not scan run records.

**Cancel and reject** settle a waiting step as they settle a waiting gate: it
fails with error `cancelled`. See "Settling a cancelled run" below.

**When a run ends.** A run saved as `succeeded`, `failed` or `cancelled` first
closes its waits (`closeRunWaits`): a wait nothing settled gets a `cancelled`
outcome, so a later signal is answered closed, and every registration of the run
is removed. A wait with no registration is skipped, so later saves of an ended
run cost one read per wait. This runs from the run repository's `beforeSave` hook
(`YamlWorkflowRunRepository`, set by `attachSignalWaits` in
`src/cli/repo_context.ts`), so cancel, reject, supersede, an abort and the
executor all do it without each having to. A store that cannot be reached does
not stop the save: the run's outcome comes first, and the sweep closes its waits
later. A signal that reached the wait before
the cancel stays its outcome; the run is cancelled all the same and the receipt
remains readable.

**How long the records live.** A registration lives until its run ends. An
outcome lives as long as its run record, so a late retry of a signal is answered
with the stored receipt from any host, and it is removed with the run: the
workflow run garbage collection removes the wait records of the runs it deletes
(`src/libswamp/data/run_gc.ts`), and deleting a workflow removes those of its
runs (`src/libswamp/workflows/delete.ts`). `sweepWaitRecords` is the safety net
for a record nothing else removed. It acts only where the run records this host
reads are the datastore's own: a filesystem datastore that stores
`workflow-runs` itself (`runsLiveInDatastore` in `src/cli/repo_context.ts`).
There it closes the registration of a run that ended after the wait was
registered, and removes a registration or outcome whose run is gone once the
wait's deadline plus 24 hours has passed.

Everywhere else it does nothing, because a run record there is not evidence
about the wait:

- On a custom datastore a run record reaches this host later than the wait's
  records. A stale `failed` copy hides a retry, which reuses the run ID and
  whose new wait is already registered; closing it would cancel a live wait.
  Comparing when the wait was registered with when the run ended narrows this
  but depends on two hosts' clocks, so it is not relied on alone.
- On a filesystem datastore whose `directories` or `exclude` settings keep
  runs in each repository, another repository's run looks deleted; removing its
  records would delete an accepted signal.

There, waits are closed by the host that ends the run, and records are removed
with the run by its garbage collection or its workflow's deletion. A registration
left by a close that failed stays until then; a signal for it sent from a host
that has the run record is still answered from that record. A run file that
cannot be read is skipped, so one damaged run does not stop the sweep, and a
sweep that fails does not fail `workflow waits`.
The sweep runs from `workflow waits` and from the run garbage collection.

**Supersede.** `workflow run` cancels suspended runs of the same workflow with
matching inputs. It leaves alone a run that has a step waiting for a signal and
reports it as kept, with its wait IDs (`skippedRuns` on the `superseded_runs`
event). Otherwise a workflow with no inputs would cancel its own waiting run
each time it is started. A run whose wait is past its deadline is left alone
too: cancelling it would discard the `failed` handler that a resume runs. So is
a run whose wait a signal has settled: its step waits in the record until a
resume applies the signal, and cancelling it would discard one. Such a run stays
suspended until someone resumes it, so a workflow started repeatedly and never
resumed accumulates suspended runs.

**Nested workflows.** A parent waiting on a child that waits for a signal is
told to signal the child's wait, then resume the child, then resume the parent.
Through serve with auto-resume on, the signal continues the child, and the
parent after it when the signaller may also signal the parent (see "Gates
inside a nested workflow").
The parent's `suspended` event names the wait in `nestedSignalWaits`
(swamp-club#3110): for each nested run still waited on, the open wait at the
innermost run that has to act, with its workflow, run, job, step, wait ID and
deadline. The execution service reads it at suspension through
`NestedRunLink.pendingWaits`, the walk a refused resume uses, whichever step the
event itself names, so a parent suspended on its own gate names a nested wait
too. One action is named per nested run, a gate before a wait, so a nested run
with a gate to decide lists no wait, and one with two open waits lists the
first. A read that fails is logged and leaves the field off. `workflow run`
prints each named wait with its signal command and, with `--json`, reports it
as `signalRequired` and lists all of them under `nestedSignalWaits`.

A wait held further down than the nested run the step waits on is printed with
the resume of the run that holds it, which has to come first; the closing hint
then says to resume the direct nested run once the run it waits on finishes.
The client knows only those two runs, so with more levels the runs between them
are covered by that sentence and not named. When the direct nested run is not
shown to the caller (serve removed `nested`, see
[serve](serve.md)), the output says the step waits on a nested run, offers no
approve command, and still names a wait the caller may read; `--json` reports
it as `signalRequired`. A suspension is taken for one on a nested run when it
has no `nested`, no `wait` and an empty prompt, and its step does not show as
`waiting`: a gate's prompt is never empty.

The refusal to resume a parent whose nested run has not finished asks the wait
store whether the nested run's wait is still open (`resolveResumableRun` passes
it to `assertNestedWaitsSettled`), so after a signal it says to resume the
nested run, and with several waits it names the first still open.

**Showing a signal before the resume.** A signal never writes the run, so the
run record shows the step waiting until a resume applies it. `workflow history
get` reads the wait's outcome when it builds the run view and sets
`wait.receipt` on a step that still waits (`showAcceptedSignals`,
`src/libswamp/workflows/history_get.ts`); the log output says a resume applies
it. The record is not written. The local command reads the store from its
read-only repository context, which carries it for a filesystem datastore only
(`requireInitializedRepoReadOnly`). A custom datastore's store pulls its
namespace when it opens, and that context neither syncs nor holds the lock, so
there the local command shows the step as the record has it; `workflow history
get --server` and the dashboard show the receipt. A wait that timed out, or whose outcome cannot
be read, is shown as the record has it. `awaitingResume` in `workflow history
get` and in run search is still false for such a run: only the waits listing
with `includeSignalled` reports that it can resume.
A parent's `steps.<nested>.outputs` holds the child's `model_method` step
outputs only, so a parent cannot read a child's signal payload.

**forEach compatibility:** A `forEach` expansion of a `wait_for_signal` step
creates one wait per iteration, each with its own wait ID. `resume()` refuses
to start while any of them is still open.

**Limits of this version:**

- Without `swamp serve`, or with the workflow's auto-resume policy off, resume
  is manual. Serve continues a run only once every wait on it has an outcome;
  it does not settle a wait that is past its deadline (swamp-club#3109), and
  it never continues one branch while another still waits. The local command
  does no authorization, as local `approve` does none.
- A retried signal is answered "already settled". Through serve, the earlier
  receipt is shown only to a caller who may read the workflow, so a caller with
  `signal` alone cannot tell its own delivery from another's. There is no
  idempotency key.
- Through serve, a wait with no readable registration (a run suspended by the
  swamp-club#3068 build, or a damaged registration file) is answered as unknown
  until a waits listing registers it.
- Without `swamp serve`, deadlines are noticed only when something looks,
  and an expired wait stays suspended until the next resume. Under serve the
  continuation sweep looks, within the limits listed under "Timing out".
- A signal does not show in the run record until the run is resumed. `workflow
  history get` and the dashboard read the wait's outcome to show it; `workflow
  history search` and run search do not, and report such a run as not awaiting
  resume. The local `workflow history get` on a custom datastore does not
  either.
- With two nested workflow steps, the log output cannot tell a sibling nested
  run's wait from one further down, and words the closing hint as for the
  latter. The commands it prints are all needed.
- A binary from swamp-club#3068 cannot read a run that waits for a signal, and
  its repo-wide commands fail while one exists (see "Mixing builds"). Older
  binaries treat a workflow file containing the task as broken.
- A resume from another host while the run's owner still runs the level it
  suspended in is not refused: the run tracker is local to a host.
- A run tracker row whose pid was reused by another live process keeps the
  resume refused until the run is cancelled.
- The dashboard lists suspended runs as awaiting approval, expired or awaiting
  resume, and lists waits for a signal with their state and the commands to run
  next. It cannot send a signal: there is no payload form. Expired
  and awaiting-resume rows have a Cancel action, which sends `workflow.cancel`
  with the run id after a second click to confirm; the sidebar count is of
  gates that can still be decided. Cancel is authorized on `run` access, so a
  reader without it sees the refusal. When the cancelled run waited on nested
  runs, the view lists the ones left suspended with their cancel commands.

### Retry Failed Steps

`swamp workflow resume <workflow> --run <id>` on a **failed** run retries it
without naming a step. Every failed step and its dependents run again, in the
same run. When a run fails, the CLI prints this command after
`To retry failed steps:`. The printed command keeps an explicit `--server` or
`--repo-dir`, and the server URL loses its userinfo, query string and fragment.
If no failed step is recorded, the CLI prints
`swamp workflow history logs <id>` instead. Serve's `workflow.resume` request
behaves the same way.

**Terms:**

- **Failed step:** a stored step with status `failed` whose recorded
  `allowedFailure` is not true. The recorded value already reflects
  `allowFailure` and the assertion severity threshold in force when the run
  failed.
- **Entry template:** the workflow step a failed step came from. This is its
  `forEachTemplate`, or else its step name.
- **Reset set:** the entry templates and their transitive dependents, as stored
  step names. It is the union of `computeStepsToReset()` over each entry
  template.

**Run selection:** a bare `resume`, with no `--run` and no `--from`, still
matches only a suspended run. Failed runs are never superseded, so this keeps
approve-then-resume from becoming ambiguous. A failed run is retried only when
it is named with `--run`. One resolver serves the CLI, serve's
`workflow.resume` handler and the detached launcher (`resolveResumableRun` in
`src/domain/workflows/suspended_run_resolver.ts`). `approve` and `reject` keep
`resolveSuspendedRun`. Auto-resume passes `suspendedOnly`, so an approval never
starts a retry. This holds even if the run fails between the approval and the
launch.

**Eligibility:** a retry is refused unless all of these hold. The refusal names
the job or step and points to `swamp workflow history logs <id>`
(`selectRetryTemplates` in `src/domain/workflows/failed_step_retry.ts`).

1. No failed step is a rejected approval. Retry never re-opens a gate.
   `--from <gate>` does, and the gate then asks for a new decision.
2. No failed step is a [stranded step](#resume-from-failed-step---from)
   (`failureKind: workflow_changed`). A retry would re-expand the same changed
   workflow and fail it again, so the refusal says to start a new run.
3. Every job and step is `succeeded`, `failed` or `skipped`. This excludes
   pending, running, waiting and unknown work. It also excludes a job left
   running by a `forEach` expansion error.
4. At least one failed step exists, and every failed job contains one.
5. Each entry template is a step of the same job in the current workflow. The
   refusal suggests only a new run, because `--from` refuses a renamed or moved
   step too (the [structure check](#resume-from-failed-step---from)). `--from`
   does still work from a remaining step after a removal. It also works from
   the template for an older `forEach` record without `forEachTemplate`.
6. Step names are unique across the workflow and across the stored run. The
   reset helper and the `steps.*` expression context key steps by name alone.
7. Step and job names hold any printable character, with space as the only
   whitespace: the schema refuses control characters, tab and newline
   (`nodeName` in `src/domain/workflows/node_name.ts`, swamp-club#3027).
   A forEach-expanded name is made printable where the expansion produces it,
   so a control character in an item value becomes a visible escape rather
   than a schema failure. Wherever a command hint prints a name,
   `quoteShellWord` shell-quotes it, and writes a name that still holds a
   control character (one from an older server) in escaped ANSI-C form.

A retry also passes the structure check. The resolver runs these checks before
anything starts. Serve therefore refuses before it registers the run or charges
the principal's cap. `resume()` runs the checks again before its first change,
so a refusal saves nothing and runs no method. Both call `planFailedRunResume`
in `src/domain/workflows/resume_reset.ts`.

**Reset:** a retry takes the same path as `--from`. It calls
`resetForResumeFrom()` with the reset set, then `resumeFromFailed()`, then the
existing resume executor. The run keeps its id and `startedAt`. `--input`
overrides merge over the stored inputs as for any resume. An override does not
reset steps that used the old value. An override that shrinks a `forEach`
collection, or renames its iterations through the step name, strands the
iterations it drops: they fail with `workflow_changed`, so start a new run with
the new inputs. Reset clears each selected step's outputs,
error, approval decision and assertion result. Only jobs that contain a reset
step return to `pending`. Steps outside the set keep their state and outputs.
Guards still decide whether a reset step runs. A guard that skips a reset step
does not restore its old outputs. A template reset repeats some successful
work. It resets every stored iteration of a selected `forEach` template and
every dependent, including a successful cleanup or notify-on-failure step.

**Failure while retrying:** `resume()` takes a snapshot of the run before
changing it. The run is saved as running before steps start. If anything throws
between that save and the first step, `resume()` saves the snapshot back and
rethrows. That covers context build, `steps.*` output resolution, evaluation
and log sink registration. The run is then exactly as it was. This also covers
suspended and `--from` resumes. A retry that throws once steps are running
completes the run as failed. It can leave pending reset steps behind. Automatic
retry refuses such a run and suggests `resume --run <id> --from <step>`.

The local `workflow resume` command reports an error from `resume()` that is not
a `UserError` as one line, `Workflow resume failed: <message>`, with the code
`workflow_resume_failed`, the code serve also sends for a failed resume. The
original error and its stack go to the debug log. A `UserError` passes through
unchanged, with its message, any next-command hint and any code it carries. An
error while an interrupted resume unwinds (Ctrl-C or `--timeout` after the run
started) is not reported; the run is recorded as cancelled instead.

**Run ownership:** the run record and the tracker row follow the resuming
process. Before any step runs, the resume records its pid, and serve's instance
id when serve drives it, so `workflow cancel` stops the resume rather than the
process that started the run. When the run leaves `running` again, the record
names its original owner once more: a run that suspends at a later gate is
cancelled and superseded as the run of whoever started it. See
[run tracker](../enablers/run-tracker.md).

**Limits:** these are part of the operator contract.

- **Retry can repeat external effects.** A method can change an external system
  and then fail. Resume does not guarantee exactly-once execution.
- **Definitions and inputs must stay compatible.** Resume uses the current
  workflow and model definitions. A failed-run resume refuses a structural
  change it would walk into (the
  [structure check](#resume-from-failed-step---from)): a renamed, moved or
  added step, a renamed or added job, or a removed job still holding unfinished
  work. It does not detect a changed step body or prove that stored results are
  still valid. If an input change affects earlier work, use `--from` or start a
  new run. A suspended resume refuses the
  same kinds of change, a moved pending step and a removed pending job, and
  leaves the run suspended.
- **`forEach` collections must stay stable.** Item identity is not kept across
  collection changes. An iteration that a failed-run resume reset and the new
  collection drops fails as a stranded step. Use a new run for a changed
  collection.
- **Stored references do not guarantee data.** Ephemeral data is gone after a
  restart, and retention can remove artifacts. Resume does not rebuild missing
  outputs or pin `data.latest()` to its old value.
- **A retried nested workflow starts a new child run.** It does not resume the
  earlier child. A step detached when its run ended (see "Gates inside a
  nested workflow") is reopened by a plain retry or `--from`, which clears its
  link and starts a fresh child; the old child stays as it was.
- **One operator per run.** There is no ownership lock. Separate CLI processes
  or serve instances can race.
- **Approvals are never reused silently.** Retry refuses a rejected approval. A
  gate in the reset set loses its decision and asks again. The `run` grant and
  `approveRequiresExplicitGrant` still govern every gate.
- **Interrupted, cancelled and running runs are out of scope.** Interrupted
  runs still use `recover`. Retry adds no crash-recovery guarantee.

### Resume from Failed Step (`--from`)

Re-enters a failed run's DAG at a named step. With `guard`, this gives safe
recovery: `--from` sets where to re-enter, and guards decide which steps run
again.

```
$ swamp workflow resume <workflow> --from <step>
$ swamp workflow resume <workflow> --from <step> --run <run-id>
```

`--run` can be left out if the workflow has exactly one failed run.

**Semantics:**

1. The `--from` step and all its transitive downstream dependents are reset to
   `pending`.
2. Steps before `--from` keep their terminal status (`succeeded`, `failed`,
   `skipped`) and the executor's existing resume-skip logic skips them.
3. Guards on reset steps are evaluated as usual, so a reset step with a truthy
   guard is still skipped.
4. Steps without a guard always run on resume. No guard means "always run this
   step."

**Step name resolution:** `--from` targets template step names as written in
the workflow YAML, not forEach-expanded iteration names. All iterations of a
forEach step are reset and re-evaluated: completed ones with truthy guards are
skipped, failed or unstarted ones run.

**Status restriction:** `--from` works only on failed runs, not succeeded or
suspended ones (use the gate-approval resume path for suspended runs). Without
`--from`, a failed run named with `--run` is retried (see
[Retry Failed Steps](#retry-failed-steps)), and a suspended run continues once
its gates are decided.

**Cross-job propagation:** If the `--from` step is in job B, only job B and
downstream jobs containing transitive dependents are reset. Upstream jobs
(job A) that succeeded keep their terminal status.

**Trigger conditions:** Trigger conditions on reset steps are still evaluated.
If the `--from` step's upstream dependency also failed, the condition sees that
`failed` status. Resume from the earlier step instead.

**Structure check:** resume walks every job of the current workflow whose stored
record is unfinished after the reset (a **re-entered job**), and looks up each
step's record in that same stored job. Before its first change, a failed-run
resume (`--from` or retry) refuses with `Start a new run.` when:

- (a) a job of the current workflow has no stored record (a renamed or added
  job). Resume would otherwise reset the run and crash on `Job run not found`;
- (b) a re-entered job has a step, other than a `forEach` template, with no
  record in that stored job (an added, renamed or moved-in step), which would
  crash on `Step run not found`. This is conservative: it also checks a job
  whose trigger condition would skip it;
- (c) a record the reset selected no longer belongs to its own job for the
  reason it was selected. A record selected by name must be a step of its own
  job. A record selected by `forEachTemplate` must be an iteration of one of
  that job's `forEach` steps. Otherwise the current workflow walks that step in
  another job, and the reset record would stay `pending` while the run reported
  success;
- (d) a job the workflow no longer has is unfinished, or holds work the run's
  abort settled without starting. Resume reopens that work but walks only the
  workflow's jobs, so the job would stay `pending` and the run could never
  finish.

The check leaves alone records selected only by the legacy `forEach` prefix
match, which can over-select (for example `deploy-canary-x` when `deploy` is
reset); unfinished records the reset did not select, such as the concrete
iteration names of a `--last-evaluated` run; `forEach` templates with no records
(an empty expansion removes the template record, so a new step cannot be told
apart from one that expanded to nothing); job and step names written with an
expression such as `deploy-${{ inputs.env }}`, which the run stores evaluated
and the check reads unevaluated, so they cannot be compared; and terminal
records and finished jobs the workflow no longer has, so removing a step or job
keeps working. The check is `planFailedRunResume` in
`src/domain/workflows/resume_reset.ts`.

**Suspended runs:** a suspended run has no reset set, so every job whose stored
record is unfinished is re-entered. Before its first change, resume of a
suspended run refuses when (a) or (b) above holds, or when:

- (c) an unfinished record of an unfinished job is no longer a step of its own
  job (for an iteration, its `forEachTemplate` as a `forEach` step), and another
  job of the current workflow has that step with no record of it: the step
  moved, and its record would stay `pending` while the run reported success. A
  `forEach` step that is now a plain step is refused too;
- (d) an unfinished job is no longer in the workflow. Resume never walks it, so
  the run would end `failed` with no failed step.

Step names are unique only within a job, so a step cannot move into a job that
already has one of that name: a record whose step another job already had was
removed, not moved. A `forEach` step can leave no record of itself (an empty
expansion removes its template record, and `--last-evaluated` or older runs
store iterations without `forEachTemplate`), so once the other job has started,
or it holds records named like iterations, the step counts as already there.

The refusal leaves the run suspended. It starts with the way out, so serve's
512-character error limit cuts the job and step detail rather than the command:

```
The workflow changed shape since the run started. To cancel it: 'swamp workflow cancel <wf> --run <id>'. Step "lint" in job "main" is not in the run.
```

A run started by `swamp serve` (it records an `instanceId`) is refused by a
local cancel and skipped by supersede, so for such a run the refusal names the
serve cancel instead: `swamp workflow cancel --run <id> --server <url>`.
The check runs in `resolveResumableRun` (the CLI, serve's
`workflow.resume` and auto-resume, before the run is registered or charged) and
again in `resume()`. It is `checkSuspendedRunResume` in
`src/domain/workflows/resume_reset.ts`. `approve` and `reject` resolve through
`resolveSuspendedRun`, which does not check.

The suspended check leaves alone: a removed step, whose unfinished records stay
`pending` while the run completes, as before; a removed finished job;
iterations whose template is still a `forEach` step of their job, whatever the
collection now evaluates to, so narrowing it through `--input` keeps working;
records with no `forEachTemplate`, from `--last-evaluated` or older runs; a
step added to a finished job, which resume never walks; a `forEach` step moved
into a job that has started; and job and step names written with an
expression. So a step added with an expression in its name, or to a job named
with one, still crashes mid-run with `Step run not found`, as it does for a
failed run. Unlike the failed-run check, it lets through a step removed from
one job but kept in another. A failed-run resume selected that record for
reset, so leaving it `pending` would falsely report success. Nothing resets a
suspended run's record, which is the removed shape that already works.

**Stranded steps:** a record the reset selected by name or `forEachTemplate` is
a **tracked reset step**. `resetForResumeFrom()` marks it `resetByResume` on the
stored step, after clearing markers an earlier resume left. The marker is
cleared when the step leaves `pending`, and it persists, so it survives a resume
that suspends again at a reset gate. When a job's walk ends, unless the run
suspended or was cancelled, a marked step still `pending` is a **stranded
step**: the current workflow no longer produces it, typically because a
`forEach` collection shrank or its iteration names changed. It fails with
`failureKind: workflow_changed` and the error
`Not run: the workflow or a forEach collection changed since the run. Start a new run.`
The failure is never an allowed failure, and its `step_failed` event carries no
model fields. Stranding is detected when the job's walk ends, so a step in the
same job that depends on the `forEach` step still runs; later jobs do not,
because the job fails. The run's JSON carries `failureKind` on the step. Retry
refuses the run, and the CLI prints `To start a new run: swamp workflow run
<wf>` instead of the retry command, with a `Run inputs:` line pointing to
`swamp workflow history get <id> --json` when the run had inputs. When the error
printed above it is a different step's real failure, a line first says that a
step did not run because the workflow changed. The resolver's status refusals still suggest a retry,
which then refuses with this reason. Workflow reports and the verification
summary count a stranded step as an ordinary failure; `failureKind` is not
carried into report details.

### Assert (`assert`)

Evaluates a CEL predicate over earlier step data, records a pass/fail result,
and fails the step when the predicate is false. It can also call model methods
with `model.method()` to check external state.

```yaml
steps:
  - name: instance-count
    task:
      type: assert
      expr: size(data.latest("cp-nodes", "instances")) == 3
      message: "Expected 3 instances, got ${{ size(data.latest('cp-nodes', 'instances')) }}"
      severity: high
```

**Fields:**

- `expr` (required, string): CEL expression evaluated with `evaluateAsync()`.
  It has the full expression context, including `data.latest()`, `inputs.*`,
  `self.*`, and `model.method()` (see
  [model.method() in guards](#modelmethod-in-guards) for syntax).
- `message` (required, string): human-readable message. Supports `${{ }}`
  interpolation. Shown on failure and included in JUnit XML output.
- `severity` (optional, `low` | `medium` | `high`, default `high`): decides
  whether a failure counts toward the `--fail-on` exit code threshold.

**Execution:** The CEL `expr` is evaluated asynchronously. Truthy marks the
step succeeded; falsy marks it failed with the resolved `message`. The
`assertResult` (passed, expr, resolved message, severity) is recorded on the
`StepRun` and saved to the workflow run record.

**Exit code control (`--fail-on`):** `swamp workflow run` accepts
`--fail-on <severity>` (default `low`). The run exits non-zero only if an
assert failure is at or above the threshold. A `low` failure under
`--fail-on high` is recorded but does not change the exit code.

**JUnit XML output (`--junit`):** `swamp workflow run --junit [--out <file>]`
emits one `<testcase>` per assert step, with a `<failure>` element when false.
Non-assert steps are left out.

**model.method() in assert:** Assert expressions can call
`model.method(modelName, methodName)` or
`model.method(modelName, methodName, inputs)`, with the same semantics as
[guard expressions](#modelmethod-in-guards). The method runs through the step
executor. It returns the parsed content of the method's `resource` data handle
if there is one, and otherwise the raw execution result as-is
(`src/domain/workflows/execution_service.ts`). This lets assertions check
external state:

```yaml
steps:
  - name: verify-instance-running
    task:
      type: assert
      expr: model.method("infra", "check-status", {"name": inputs.instanceName}).stdout == "running"
      message: "Instance ${{ inputs.instanceName }} is not running"
      severity: high
```

**forEach compatibility:** Assert steps support `forEach` expansion. Each
iteration produces its own assert result and JUnit `<testcase>`.

**Known limitation (message interpolation):** The `${{ }}` pattern in
`message` matches non-greedily, so a CEL expression with a literal `}}` (e.g.
map or struct literals) is split too early. The error is caught silently and
the expression is left as-is. Keep `message` interpolation to simple value
lookups and put complex CEL in `expr`.

**Known limits:**

- `expr` must be a raw CEL expression. Wrapping it in `${{ }}` fails
  validation (`validateAssertExprNotInterpolated` in
  `src/domain/workflows/validation_service.ts`).
- An assert failure below the `--fail-on` threshold is recorded as an
  **allowed failure** (`markAllowedFailure`). Downstream `succeeded` conditions
  see the step as failed, but the run can still succeed.
- `--fail-on` is rejected together with `--server`
  (`src/cli/commands/workflow_run.ts`). `--junit` cannot be combined with
  `--json` or with NDJSON `--stdin` batches, and `--out` requires `--junit`.

## Concurrency Limits

By default, all jobs in a topological level run at once, and so do all steps in
a topological level (maximum parallelism). The optional `concurrency` field caps
how many units run at once at each level:

```yaml
concurrency: 10  # workflow level — caps parallel jobs

jobs:
  - name: fan-out
    concurrency: 5  # job level — caps parallel steps in this job
    steps:
      - name: per-item
        forEach:
          item: target
          in: ${{ inputs.targets }}
        concurrency: 3  # step level — caps forEach iterations
        task: { ... }
```

**Semantics:**

- A positive integer is a hard cap on units running at once at that level.
- `0` or absent means unbounded (the current default).
- Resolution order is step > job > workflow > unbounded. Step-level values are
  collected across the topological level, and the minimum applies to every
  step stream in that level (`src/domain/workflows/execution_service.ts`).
  Only absent values fall through. An explicit `0` at the job level does not
  fall through to the workflow value; it resolves to unbounded (or the global
  ceiling).
- The global `SWAMP_MAX_CONCURRENT_STEPS` environment variable sets a
  host-level ceiling. When both are set, the effective limit is
  `min(local, global)`. On `workflow resume` the ceiling applies at the step
  level only; the job-level limit comes from the workflow as written.

Limiting uses a semaphore-gated `mergeWithConcurrency()` that wraps the
existing `merge()` stream combinator. When the limit is unset or above the
stream count, the unbounded `merge()` path runs with zero overhead.

Workflows are YAML files in the repository's top-level `workflows/` directory,
named `workflows/workflow-{name}.yaml` and validated with Zod. Legacy
`workflow-{uuid}.yaml` files are also supported. Run output is stored in the
datastore at `workflow-runs/{workflow-id}/workflow-run-{run-id}.yaml` (default
path: `.swamp/workflow-runs/`).

## Validation

`swamp workflow validate` checks structure (schema, unique names, dependency
references, cycles) and checks each step's inputs against the resolved
method's required arguments. To resolve a step's model type, the local path
first hot-loads pulled and local extensions (`modelRegistry.ensureLoaded()` in
`src/cli/commands/workflow_validate.ts`), as `swamp model type describe` and
`swamp model validate` do. With `--server`, the serve instance validates,
resolving types from its own loaded registry.

Results have three severity levels:

- **Pass** (green ✓): the check succeeded.
- **Warning** (yellow ⚠): the check passed but something looks suspicious.
  Warnings do not fail validation or change the exit code.
- **Fail** (red ✗): the check failed. Any failure gives a non-zero exit.

Step-input checks fail when the resolved method does not exist
(`method_not_found`) or a required argument is missing. A step whose model
type cannot be resolved also fails. It is never skipped as a pass, which
would hide real contract bugs such as non-existent method names or wrong
argument keys. Dynamic CEL references (`${{ ... }}`) in model or type names are
skipped, since they only resolve at run time. A reference to a model
instance that does not exist locally (`model_not_found`) is a warning, not a
failure: an upstream step may create it during the run, but it could
also be a typo.

### GlobalArgument Input References

A model definition's `globalArguments` or method-level argument defaults may
contain `${{ inputs.* }}` expressions. The validator checks that the calling
step's `inputs:` block supplies each referenced input. Otherwise the run would
fail with an unresolved expression, for example when a definition expects
`host: ${{ inputs.ip }}` and the step never provides it. The check uses the
step's inputs, not the workflow's top-level inputs, because in a model
definition `${{ inputs.* }}` is the model's own input namespace, filled by the
step at runtime.

Steps with dynamic inputs (a single `${{ ... }}` expression as the whole
`inputs` value) or dynamic model references are skipped, since neither can be
analysed statically. A nested-workflow step whose target workflow cannot be
found reports its input check as "skipped", not failed
(`src/domain/workflows/validation_service.ts`). The validator also checks
placement fields (`queueTimeout`, `affinity`, `writes` without a placement) and
the assert-`expr` interpolation rule above.

### Unknown Keys Are Rejected

The workflow, job, and step schemas reject unknown keys at parse time with an
actionable error (swamp-club#1240). A `rejectUnknownKeys` preprocess hook turns
off Zod's default stripping. It runs after the removed-driver-fields guard,
which keeps its own migration message.

- Placement properties (`labels`, `target`, `platform`, `queueTimeout`) are
  valid at the workflow, job, and step level (swamp-club#1685). Workflow-level
  placement is the default for all steps; job level overrides workflow, and
  step level overrides job.
- Any unknown key gets a did-you-mean suggestion (Levenshtein) and the list of
  valid keys for that entity.

The repository loader skips a schema-rejected file with a warning, so it is
invisible there. On a lookup miss, `workflow validate` and `workflow run`
re-scan the raw files and show the parse error inline. A broken file fails
validation naming the bad key, and can never make `validate` (or validate-all)
report green.

**Schema evolution consequence**: saved evaluated-workflow snapshots and
suspended approval runs are re-parsed through these schemas on resume. Removing
a schema field therefore breaks data saved before the removal and needs an
explicit migration or tolerance decision, never a silent strip. The removed
`driver`/`driverConfig` fields chose a hard, actionable failure.

## Workflow Definition

Workflows live in `workflows/workflow-{name}.yaml` (legacy
`workflow-{uuid}.yaml` files are also supported). Each has a unique id, a
globally unique name, a set of jobs, and optional workflow inputs.

A workflow reference — a CLI argument, a `workflowIdOrName` — resolves by name
first, then by exact id, the same rule as model definitions
(`src/domain/workflows/workflow_lookup.ts`). A name may be a UUID, so a
workflow named with another workflow's id wins over the workflow with that id.
Only a file that declares an id is returned for that id, even though a
workflow named with the UUID is stored at the same `workflow-{uuid}.yaml`
path.

### Workflow Inputs

Like model definitions, workflows can declare their own inputs (workflow
inputs) as JsonSchema. Inputs let you parameterize a workflow without editing
its definition file:

```yaml
id: abc123
name: deploy-application
inputs:
  environment:
    type: string
    enum: ["dev", "staging", "production"]
    description: "Target environment for deployment"
  version:
    type: string
    description: "Application version to deploy"
  enableRollback:
    type: boolean
    default: true
    description: "Enable automatic rollback on failure"
jobs:
# ... job definitions can reference ${{ inputs.environment }}, etc.
```

**Workflow Input Rules:**

- Specified as JsonSchema (same rules as model inputs)
- Can be required or optional
- Read through CEL expressions: `${{ inputs.someWorkflowParameter }}`
- Called "workflow inputs" to tell them apart from "model inputs"
- Provide dynamic configuration for workflow execution

See [expressions](../enablers/expressions.md) for CEL syntax and
[models](./models.md) for detailed input specification patterns.

### Vaults Allow-List

A workflow can declare `vaults:`, the most vaults any of its runs may read or
write (swamp-club#2676):

```yaml
name: provision-room
vaults: [roomcontrol, bot-outputs]
jobs:
# ...
```

Every vault operation in a run of the workflow — `vault.get` expressions,
method code using `context.vaultService`, sensitive outputs and their
read-back — on a vault not listed is refused, whoever triggered the run. The
list is the author's maximum and needs no serve: it bounds local
`swamp workflow run` as well as serve runs, where it applies alongside the
triggering principal's vault grants, so either can refuse (see
[access-control § Vaults](../enablers/access-control.md#vaults)). A nested
workflow's list intersects with its parent's, so nesting only narrows. A model
method run outside a workflow has no list. Without `vaults:` nothing changes.

A run records the list in force when it starts (its own intersected with any
parent's) as `allowedVaults` on the run record. A resume is held to both that
recorded list and the workflow's current list, so editing the workflow while a
run is suspended can narrow the run but never widen it. A run that recorded no
list (none applied, or it started on an older release) is held to the current
list alone.

Sensitive outputs land in a vault too, so the list must include the vault each
step's sensitive outputs are stored in (field `vaultName`, the step's
`dataOutputOverrides`, the spec's `vaultName`, `defaultVault`, then the first
user vault). A mutating method whose outputs would land in an unlisted vault is
refused before it runs.

`swamp workflow validate` reports a static `vault.get` name in the workflow's
own steps or inputs that is not listed, and each sensitive-output target vault
of a model-method step that is not listed. Dynamic names and `vault.get` inside
model definitions are caught only at run time.

The workflow schema is strict, so a release older than the field rejects a
workflow file that sets `vaults:`. Upgrade every machine and serve replica that
loads the workflow first.

Implementation: `vaults` in `src/domain/workflows/workflow.ts`, the check in
`src/domain/workflows/validation_service.ts`, the scope in
`src/domain/vaults/run_vault_access.ts`.

### Workflow Triggers

A workflow can declare an optional `trigger` object holding trigger
configuration, so that `swamp serve` runs it automatically.

#### Schedule Trigger

A `schedule` trigger runs the workflow on a cron schedule:

```yaml
id: abc123
name: anime-downloader
trigger:
  schedule: "0 3,12 * * *"
jobs:
  # ... jobs run automatically at 3am and noon
```

**Schedule behavior:**

- Uses [croner](https://github.com/Hexagon/croner) grammar. Standard cron has 5
  fields (minute, hour, day-of-month, month, day-of-week). A 6-field expression
  puts **seconds first**. `@daily`-style nicknames and the `L` / `#` modifiers
  are accepted.
- Validated at parse time by building a croner `Cron`
  (`src/domain/workflows/workflow.ts`).
- On `swamp serve` startup, every workflow with a schedule is registered.
- A filesystem watcher on the effective workflows directory reloads live: the
  repo's `workflows/` directory, or the managed config `workflows/` directory
  when `managedConfig` is on — the same directory the workflow loader reads.
  Adding, changing, or removing a schedule takes effect without a restart.
- Each scheduled fire calls the `executeWorkflow` callback injected into
  `ScheduledExecutionService` (`src/libswamp/workflows/scheduled_execution.ts`).
  Serve wires it to `executeWorkflowWithLocks` (`src/serve/deps.ts`), the same
  path as WebSocket `workflow.run` and webhooks, not the local CLI path.
- In an HA deployment, each fire is claimed once across instances through the
  `cronFireDedup` hook. A workflow fires single-flight per instance.
- **Overlap prevention:** if a workflow is still running from the previous
  scheduled trigger, the next trigger is skipped with a warning.
- **Concurrency:** fires that are not skipped join one queue. Up to
  `--max-concurrent-scheduled-runs` (serve setting, default 1) run at once:
  different workflows run together, and a workflow never overlaps itself — a
  fire that arrives while the same workflow is still queued waits behind it.
  At the default, scheduled runs go one at a time in fire order. Each
  schedule's queue state (`queued`, `oldestQueuedAt`, `lastQueueDelayMs`) is
  reported in health and on `/health`.
- **No catch-up:** serve does not fire schedules it missed while it was down.
  On startup it waits for the next natural cron tick.
- `--no-schedule` on `swamp serve` turns off scheduled execution.

The `ScheduledExecutionService` lives in libswamp, so any consumer (serve, a
future daemon, or programmatic use) can reuse the same scheduling code.

#### Trigger Overrides

Extension-bundled workflows are read-only, so users cannot edit their YAML to
add or change a trigger. The `triggers` section in `.swamp/serve.yaml` holds
per-workflow overrides that survive extension updates. Manage them with the CLI
or by editing `serve.yaml` directly:

```bash
# Set a trigger override (replace semantics — writes the full entry)
swamp workflow trigger set @swamp/cve/researcher/scan --schedule "0 3 * * *" --input 'channel=#security'
swamp workflow trigger set daily-report --schedule "0 8 * * 1-5"

# Show the effective trigger (built-in merged with override)
swamp workflow trigger get @swamp/cve/researcher/scan

# Remove a trigger override
swamp workflow trigger remove daily-report
```

The same overrides in `serve.yaml`:

```yaml
# .swamp/serve.yaml
triggers:
  "@swamp/cve/researcher/scan":
    schedule: "0 3 * * *"
    inputs:
      channel: "#security"
  daily-report:
    schedule: "0 8 * * 1-5"
```

Each key is a workflow name, including scoped `@collective/name` patterns. An
override `schedule` **replaces** the workflow's built-in schedule
(`resolveSchedule` in `src/libswamp/workflows/scheduled_execution.ts`). An
override `inputs` map is deep-merged over the built-in `trigger.inputs` at fire
time. A workflow with no built-in trigger block gets one from the override.
`swamp workflow trigger set` requires `--schedule`
(`src/cli/commands/workflow_trigger_set.ts`). Unknown keys in an override entry
produce a warning and are ignored (`src/serve/serve_config.ts`).

**Override behavior:**

- Applied when `ScheduledExecutionService` starts, in two phases. Every
  workflow with a schedule (built-in or override, resolved through
  `resolveSchedule`) is registered first, then the override map is walked for
  any remaining names. An inputs-only override on a workflow with no schedule
  from either source is logged and does nothing.
- The `handleScheduleChange` callback also reads the override map, so
  live-reloaded workflows respect overrides.
- Overrides for unknown workflow names are logged as warnings and skipped.
- Overrides are read at startup. Two paths apply changes to a running instance:
  1. `swamp workflow trigger set/remove --server` writes the config file serve
     was started with (`--config`, or `.swamp/serve.yaml`), then
     calls `updateTriggerOverrides` directly on the `ScheduledExecutionService`.
     No `--hot-reload` flag is needed
     (`src/serve/handlers/workflow_handlers.ts`).
  2. `swamp serve reload` (SIGHUP or WebSocket `serve.reload`) re-reads all
     overrides from that same file as part of a full reload. This requires
     `--hot-reload`.
- Works with both extension and local workflows. The main use case is extension
  workflows that cannot be edited directly.

**Precedence for schedule:** `serve.yaml override > workflow YAML trigger`

**Precedence for trigger inputs:** override inputs are deep-merged over the
workflow's built-in `trigger.inputs`. Override keys win; built-in keys missing
from the override fall through. The existing
`caller inputs > trigger.inputs > schema defaults` layering is unchanged.
Override inputs take the caller inputs slot, above built-in `trigger.inputs`.

#### Trigger Inputs

Scheduled and webhook runs have no `--input` flag. A `trigger.inputs` map
supplies baseline input values at fire time:

```yaml
trigger:
  schedule: "* * * * *"
  inputs:
    projectId: "a6b254a2-0b57-4d0f-bf8b-fef767ab119e"
jobs:
  # ... runs with projectId already populated
```

A workflow can then declare `required` inputs without misusing the input
schema's `default`, which would apply to every caller, not only trigger-fired
runs. `trigger.inputs` is a plain map of runtime values to inject. The
workflow's `inputs` block is different: it is the JSON-Schema description of
allowed inputs.

**Precedence:** the values merge like `--input` on
`swamp workflow run`, layered as `caller inputs > trigger.inputs > schema
defaults`. A scheduled run has no caller, so `trigger.inputs` is the baseline.
The merged inputs go through the same coercion, default-application, and
validation pipeline as every other run, so a `required` input satisfied only
by `trigger.inputs` validates.

`executeWorkflowWithLocks` layers in trigger inputs (`workflow.baselineInputs`
in `src/serve/deps.ts`), so they apply to every serve-executed run: scheduled,
webhook, and ad-hoc `workflow.run` requests from
`swamp workflow run --server`. Only a local `swamp workflow run`, which calls
`workflowRun` directly (`src/cli/commands/workflow_run.ts`), ignores
`trigger.inputs`. There the operator supplies inputs.

#### Webhook Payload Extraction

For webhook runs, `trigger.inputs` values may be CEL expressions that read the
incoming request through the `webhook` namespace. This maps payload fields onto
named workflow inputs:

```yaml
trigger:
  inputs:
    identifier: "${{ webhook.body.data.issue.identifier }}"
    eventType: '${{ webhook.headers["x-linear-event"] }}'
inputs:
  type: object
  properties:
    identifier: { type: string }
  required: [identifier]
jobs:
  # ... runs with identifier populated from the webhook body
```

The `webhook` namespace exposes:

- `webhook.body`: the request body, parsed as JSON when the payload is valid
  JSON, otherwise the raw string.
- `webhook.headers`: request headers as a map of lowercased names to values. The
  active scheme's signature header and sensitive credential headers are removed.
  Redacted headers (`REDACTED_HEADERS` in `src/serve/webhook.ts`) include:
  - authentication: `authorization`, `proxy-authorization`, `cookie`,
    `set-cookie`, `x-api-key`, `x-auth-token`
  - provider signatures: `x-hub-signature`, `x-shopify-hmac-sha256`
  - proxy credentials: `x-amzn-oidc-accesstoken`, `x-amzn-oidc-data`,
    `x-goog-iap-jwt-assertion`, `cf-access-jwt-assertion`,
    `x-forwarded-client-cert`
  - any header ending in `-token` or `-secret`
- `webhook.route`: the matched webhook route (e.g. `/hooks/linear`).

Each endpoint picks its signature scheme on the `--webhook` flag:
`<route>:<workflow>:<secret>[:<scheme>[:<header>[:<prefix>]]]`. `scheme` is
`github` (the default, `X-Hub-Signature-256`), `jira` (`X-Hub-Signature`),
`linear`, `stripe`, `slack`, `generic`, or a webhook extension type
(`@collective/name`, e.g. `@swamp/telegram`). `generic` requires a header name
and accepts an optional value prefix. With no scheme the flag behaves as
before, so the secret may still contain colons: a scheme is recognized only
when the fourth field is a known scheme keyword or an extension type. An
extension may `transform` the body before it becomes `webhook.body`, but
`webhook.headers` is always the redacted map computed by core.

These expressions are evaluated against the verified payload at fire time,
before input validation, so a payload field can satisfy a `required` input.
A whole-value expression keeps the field's native type (object, number,
boolean); one inside a larger string is interpolated.

swamp's CEL has no `??` operator. Guard optional payload fields with the
`has()` macro and a ternary instead:

```yaml
trigger:
  inputs:
    identifier: >-
      ${{ has(webhook.body.data.issue) ?
        webhook.body.data.issue.identifier : webhook.body.data.identifier }}
```

A hard reference to a missing field (without a `has()` guard) raises an error
and the run does not start. The `webhook` namespace exists only inside
`trigger.inputs`. The rest of the workflow reads the extracted values as normal
inputs (`${{ inputs.identifier }}`).

**Security:** Sensitive headers are redacted before the payload is saved or
exposed to workflow expressions. Provider event headers (e.g.
`x-github-event`, `content-type`) are kept.

**Limits** (`src/serve/webhook.ts`): request bodies are capped at 10 MB and the
in-memory run queue at 100 entries. Every verification failure returns the
same `401`, so the response cannot be used as an oracle. Webhook endpoints can
also be declared in a `webhooks:` array in `.swamp/serve.yaml`
(`src/serve/serve_config.ts`), with secrets given as `@env=`, `@file=`, or
`@vault=` references. CLI `--webhook` flags replace the config-file entries
completely.

## Jobs

Each job has a name, a description, a series of steps, and a list of the jobs
it depends on, each with the condition that triggers this job. Each `dependsOn`
entry is `{ job, condition }`. The condition is `always`, `succeeded`,
`failed`, `completed`, `skipped`, or a boolean combination with `and` / `or` /
`not` (`src/domain/workflows/trigger_condition.ts`,
`src/domain/workflows/job.ts`). For example, job C can depend on jobs A and B
and run only if either failed.

## Steps

Each step has a name, a description, and a task: a model method to run or a
nested workflow to invoke. Steps use the same dependency logic as jobs.

When a step calls a mutating model method (`create`, `update`, `delete`,
`action`), the model's pre-flight checks run first. If any check fails, the step
fails without running the method. Set `allowFailure: true` on the step to let
the workflow continue past a pre-flight failure.

## Allow Failure

A step marked `allowFailure: true` can fail without failing the job or
workflow. This helps test or diagnostic workflows where some steps may fail for
external reasons (e.g., billing plan limitations).

When such a step fails:

- The step is recorded as failed with its error message.
- The failure is not propagated to the job, so the job can still succeed.
- The step run is flagged with `allowedFailure: true` in the run output.
- Trigger conditions behave normally: `succeeded` evaluates to `false` (the
  step did fail), and `failed` and `completed` evaluate to `true`.
- Downstream steps with `dependsOn: succeeded` skip; those with
  `dependsOn: completed` fire.

```yaml
steps:
  - name: optional-check
    allowFailure: true
    task:
      type: model_method
      modelIdOrName: checker
      methodName: validate
  - name: always-runs
    dependsOn:
      - step: optional-check
        condition:
          type: completed
    task:
      type: model_method
      modelIdOrName: runner
      methodName: execute
```

## Guard (Idempotent Step Execution)

A step can declare a `guard`, a CEL expression evaluated before the step runs.
A truthy guard skips the step (already done). A falsy or absent guard lets it
run normally.

Guard is the workflow-level primitive for idempotent steps. It makes resume,
re-run, and cron scheduling safe without re-running completed steps.

### Evaluation order

1. Dependency conditions are checked (`dependsOn`)
2. Expression context is built (including `self.*` for forEach steps)
3. Guard expression is evaluated via `celEvaluator.evaluateAsync()`
4. If truthy → step is skipped with reason `"guarded"`
5. If falsy → step proceeds to execution

Each `forEach` iteration checks its step's `dependsOn` before its own guard, as
a plain step does. An unmet condition skips every iteration with reason
`"dependency"`. A `dependsOn` that names a `forEach` step sees one status for
all of its iterations (`JobRun.getStatus()`): running while any is unfinished,
unknown if any is unknown, failed if any failed, skipped if all were skipped,
and otherwise succeeded.

### Expression context

Guards see the same context as other step expressions:

- `inputs`: workflow inputs
- `data`: data namespace (e.g., `data.latest()`)
- `self`: for forEach steps, includes the iteration variable

### Guard patterns

```yaml
steps:
  # Data truthiness — truthy scalar means done, null means not done
  - name: read-plate
    guard: ${{ data.latest("plate-reader", "scan-complete").attributes.id }}
    task:
      modelName: plate-reader
      method: read-all

  # Value comparison — same batch means skip, different batch means re-run
  - name: dispense-reagent
    guard: >
      ${{ data.latest("liquid-handler", "dispense-log").attributes.batchId
          == inputs.batchId }}
    task:
      modelName: liquid-handler
      method: dispense

  # Method call — invoke a model method to check external state
  - name: create-instance
    guard: >
      ${{ model.method("infra", "check-exists",
          {"name": inputs.instanceName}).stdout }}
    task:
      modelName: infra
      method: create
```

### model.method() in guards

`model.method(modelName, methodName)` or
`model.method(modelName, methodName, inputs)` calls a model method and returns
the content of its first resource data output, parsed as JSON if possible.
Guards use it to check external state with a lightweight probe method.

The method runs through the same step executor as regular workflow steps, so it
has full access to vault secrets, expression context, and data storage. For
command/shell models the returned content is `{exitCode, stdout, stderr, ...}`,
so guards usually read one field such as `.stdout`.

### forEach compatibility

Guards can reference `self.*` (the forEach variable), so each expanded
iteration evaluates its own guard:

```yaml
- name: read-plate
  forEach:
    item: well
    in: ${{ range(1, 97) }}
  guard: ${{ data.latest("plate-reader", self.well) }}
  task:
    modelName: plate-reader
    method: read-single-well
```

On resume, completed wells are skipped and failed or unstarted wells run.

### Error handling

A CEL parse or runtime error in a guard fails the step. Guard errors are not
swallowed. They produce a `step_failed` event with the error message.

### Events and rendering

Guard-skipped steps emit a `step_skipped` event with `reason: "guarded"`
(`"dependency"` for dependency skips). The event includes `guardExpression`
(the raw CEL string) and `guardResult` (the evaluated value), so consumers can
show why the step was skipped.

Console output names the skipped step and shows the guard expression inline:

```
   main │ skipped do-work (guarded) · guard: data.latest("checker", "result").attributes.exitCode == 0
```

In `--json` mode, each guarded skip writes a line with both fields to stderr:

```json
{"step":"do-work","job":"main","status":"skipped","reason":"guarded","guardExpression":"data.latest(\"checker\", \"result\").attributes.exitCode == 0","guardResult":true}
```

stdout holds only the run document, where each guard-skipped step carries
`skipReason: {"kind": "guarded", "expression": ...}`. The renderer writes
through `unguardedConsole` (`src/domain/models/console_guard.ts`), so these
lines never pass through the console guard of a concurrently running method.

Debug-level logging (`--log-level debug`) shows the guard expression and its
result for both skipped and non-skipped steps.

## Data Output Overrides with Vary Dimensions

Steps can set `vary` on `dataOutputOverrides` to keep data separate per
environment. `vary` lists input key names whose values are appended to the data
instance name, giving names like `result-prod` or `result-dev-us-east-1`.

### Syntax

```yaml
steps:
  - name: scan-${{ self.env }}
    forEach:
      item: env
      in: ${{ inputs.environments }}
    task:
      type: model_method
      modelIdOrName: scanner
      methodName: execute
      inputs:
        environment: ${{ self.env }}
    dataOutputOverrides:
      - specName: result
        vary:
          - environment
```

### On-Disk Layout

With `environments: ["dev", "staging", "prod"]`, the example above produces:

```
data/scanner/{id}/
  result-dev/
    1/content.json
    latest → 1
  result-staging/
    1/content.json
    latest → 1
  result-prod/
    1/content.json
    latest → 1
```

Each environment gets its own versions and `latest` marker, so data from
different environments never interleaves.

### Accessing Varied Data

Use the 3-argument form of `data.latest()` to read varied data, usually from a
forEach step or through workflow inputs:

```yaml
# In a forEach step, use the iteration variable:
inputs:
  scanResult: ${{ data.latest('scanner', 'result', [self.env]).attributes.count }}

# Or use a workflow input:
inputs:
  scanResult: ${{ data.latest('scanner', 'result', [inputs.environment]).attributes.count }}
```

See [Expressions](../enablers/expressions.md) for the full vary dimensions
syntax.

## Pre-flight Check Control

Workflow runs support the same pre-flight check skip options as direct model
method runs. The flags apply to every model method step in the workflow:

| Flag                         | Behavior                                   |
| ---------------------------- | ------------------------------------------ |
| `--skip-checks`              | Skip all pre-flight checks                 |
| `--skip-check <name>`        | Skip a specific check by name (repeatable) |
| `--skip-check-label <label>` | Skip all checks with a label (repeatable)  |

The options pass from the CLI through `WorkflowRunInput` →
`StepExecutionContext` → `MethodContext`, so behavior matches
`swamp model method run`.

## Workflow Runs

A run executes the jobs and steps in dependency order. The order should be a
weighted topological sort, so that identical inputs should give the same run
order.

The run's output is written to a workflow run log in the datastore at
`workflow-runs/{workflow-uuid}/workflow-run-{run-uuid}.yaml` (default path:
`.swamp/workflow-runs/`).

### Run Statuses

- `pending`: created but not yet started
- `running`: executing jobs/steps
- `suspended`: paused at a manual approval gate
- `succeeded`: all jobs completed successfully
- `failed`: at least one job failed or an error occurred
- `cancelled`: cancelled by a user
- `interrupted`: the owning process crashed or was killed. In-flight steps are
  `unknown` and the run is recoverable (see [Recovery](#recovery) below)

### Cancellation

Cancel a run with `swamp workflow cancel <workflow> [--run <runId>]`. When
`swamp serve` is running, the command calls the serve cancel API
(`POST /api/v1/cancel/workflow-run/<id>`), which fires the AbortController to
stop the run live. When serve is not running, the command cancels offline: it
stops the owning `workflow run` process (SIGTERM, then SIGKILL after a grace
period), re-reads the run, and writes the cancelled status to the run YAML only
if the run is still active. The owner saves its own final record while handling
SIGTERM, once its in-flight model methods have stopped or the step stop grace
ran out (see [Post-Cancellation Cleanup](#post-cancellation-cleanup)), so a run
it already finished keeps that record; a cancelled one gets the `--reason` as
its `cancel_reason` tag. An owner killed after its grace, or one that died
before the cancel, saved nothing: once it is gone, cancel cancels each step
method-run record it left `running` with the same error its step gets
(`OWNER_STOPPED_STEP_ERROR`), then completes its tracker rows still `running`
on this host as `cancelled` with the reason (`closeStoppedOwnerRuns`,
`src/cli/commands/workflow_cancel.ts`). An owner still alive is left alone.

**Finding the run.** A local cancel looks the run up in the run store, not
through the workflow's definition (`resolveLocalCancelTarget`,
`src/cli/commands/workflow_cancel.ts`), so a run outlives its workflow file: a
run whose definition was deleted is still cancelled, and settled as described
below.

- `--run <id>` finds the run by its id alone, and needs no workflow argument.
  A workflow given with it must be the run's own: its workflow id, the name the
  run recorded, or its definition's current name. Otherwise the run is not
  found.
- A workflow alone picks its latest active run. A name or id that resolves no
  definition falls back to the active runs of deleted workflows that carry it,
  matched on the workflow id or the name the run recorded. A name a newer
  workflow reuses therefore means the newer one; the deleted workflow's runs
  stay reachable by run id.
- `--all` cancels the active runs of every workflow, then those of deleted
  workflows, reported under the name they recorded and listed last. An
  unreadable run file fails `--all` with its read error before anything is
  cancelled.

The runs of deleted workflows are found without reading the rest of the run
store. Only run directories that no loaded definition owns are looked at, each
through its run index, and a run is loaded only when the index says it is
active and, for a lookup by name, that it carries that name or id. So a
mistyped name costs a listing of the run directories, not a parse of every
run. On a lookup by name, a run directory that cannot be read is skipped with a
warning, so a damaged record elsewhere does not turn `Workflow not found` into
a read error.

A workflow whose file exists but fails to load is not a deleted workflow. The
repository skips such a file, so its runs look like a deleted workflow's;
`listBrokenWorkflows` tells them apart, by the file's id or name or, for a file
too broken to give either, by its file name. `--all` leaves those runs as they
are and lists them under `notCancelled` with the file and its error; a cancel
by the workflow's name is refused the same way. `--run <id>` still cancels the
run, since it names it.

**Run claims.** Approve, reject, cancel, supersede and the start of a resume
each load a run's record, change it and save the whole record back. Two of them
on one run at once would save over each other, and the first to save would have
reported a result that no longer holds: a cancel could print `cancelled` and
the run end up `suspended` again with its gate approved (swamp-club#2919). Each
of them therefore holds the run's claim (`WorkflowRunClaims`,
`src/domain/workflows/run_claim.ts`) from its load to its save, and reads the
run again once it has the claim. The second command to arrive sees what the
first saved:

- Cancel or supersede after an approve cancels the approved run: the gate
  stays `succeeded` and the steps behind it are settled as cancelled.
- Approve or reject after a cancel or supersede is refused with
  `Run <id> is not suspended (status: cancelled)`.
- Cancel after a reject leaves the run `failed` and reports that status.
- Resume after a cancel is refused before it changes anything. A cancel after
  a resume has taken the run over finds it `running` under the resuming
  process and stops that process, as for any running run. That holds when the
  resume takes over after cancel chose which process to stop: cancel checks
  the owner again under the claim, saves nothing over a live process it has
  not stopped, stops it, and settles again (`settleStoppingNewOwners`,
  `src/cli/commands/workflow_cancel.ts`). It never stops a serve instance:
  when the process that took the run over is `swamp serve` (an approval
  through serve auto-resumed it), the local cancel is refused, saves nothing,
  and points at `--server`. `cancel --all` lists such a run under
  `notCancelled` and goes on to settle the rest. A run whose claim cannot be
  taken in time is listed there too, unless its stopped owner already saved
  it cancelled or finished, and the command then exits 75 once every run is
  reported.

The local commands back the claim with a datastore lock per run
(`createWorkflowRunClaims`, `src/cli/repo_context.ts`; the key is under
"Concurrency Control" in `design/enablers/datastores.md`), so it holds across
processes that write the same datastore directory. With a custom datastore that
has a local cache, the provider's lock orders writers on every machine, but
each machine reads the run from its own cache and these commands do not pull
under the claim, so two machines can still decide from different copies.
Stopping a run's owner process happens before the claim is taken, and a resume
releases the claim before any step runs: the claim is never held while work
executes. A resume whose preparation fails takes the claim again to put the
run back, and leaves the record alone if a cancel settled it in the meantime. `swamp serve` keeps other writers in its own process off a
run with its active-run registry reservation instead, and passes
`unclaimedRuns` to approve, reject and resume; its supersede, which cancels
locally-owned runs, takes the lock-backed claim. So a local approve or reject
of a run that a serve process on the same repository is deciding at the same
moment is not serialized. `integration/workflow_run_claim_rules_test.ts` pins
the files that take the claim and the files that opt out.

**Settling a cancelled run.** Every cancel settles the work the run leaves
unfinished before it marks the run `cancelled`, so a cancelled record never
keeps a job `running` or a step `running`, `waiting_approval` or `waiting`. That
holds for
a live abort, an offline cancel of a suspended run or of one whose owner died,
a supersede, serve's cancel of a suspended run, and the backstops that cancel a
run an interrupted `workflow run` or `workflow resume` left running. All of
them go through `cancelAndSettle` (`src/domain/workflows/abort_settlement.ts`),
the only production caller of `WorkflowRun.endAsCancelled`;
`integration/workflow_run_cancel_settlement_rules_test.ts` pins that.

- A step still `running` (its owner died) fails with error `cancelled`.
- A `waiting_approval` gate fails with error `cancelled`.
- A `waiting` step (a wait no signal settled) fails with error `cancelled`.
- A pending step is skipped when its `dependsOn` is unmet, otherwise it fails
  with error `cancelled`. A step with a `guard` stays `pending`: its guard
  never decided.
- A pending job whose `dependsOn` is unmet is skipped. Any other job still
  `pending` or `running` ends from its steps: `failed` when a step failed,
  `unknown` (or still `pending`, for a job that never started) while a guarded
  step is undecided, otherwise `succeeded` or `skipped`.

The steps a cancel settles without running them are marked `settledByAbort`.
A cancelled run cannot be resumed, so the marker only records that the cancel
settled them. Conditions are evaluated in dependency order against the run's
own evaluated workflow snapshot, which `workflow run` saves under
`workflows-evaluated/runs/<runId>/` when the run starts, so the evaluated job
and step names in the run's records match. Without a snapshot (a
`--last-evaluated` run, an older run, a snapshot run gc removed, or one not yet
hydrated from a lazy datastore) the current workflow definition is used. A job
or step that definition does not name, and every job when there is no
definition or its jobs or steps form a cycle, is settled from its records
alone, with every unfinished step failed as `cancelled`. Because settled steps
are failed, the run's history reports a failed step and failure reason
`cancelled`, as it does for a run aborted live. A step that failed on its own
is reported ahead of any step the settlement failed
(`WorkflowRun.failureInfo`), so a run keeps naming its real failure.

**Settling a rejected run.** `workflow reject` goes through
`completeAndSettle` in the same module: it fails the rejected gate, settles
every job and step still open by the rules above, including the gate's own job
and dependents, then completes the run as `failed`. Its settled steps are
marked `settledByAbort`, and since a failed run can be resumed, a resume runs
them. Outside the live walk in `execution_service.ts`, `completeAndSettle` is
the only production caller of a run's `complete()`; the same fitness test pins
that.

`swamp workflow cancel --all` cancels all active runs across all workflows.
With `--server`, `--run <id>` is required and `--all` is rejected. `--reason`
is sent in the request body, and the run records it as
`<reason> (cancelled by <principal>)`, as a WebSocket `workflow.cancel` does.
The CLI reports the reason the server says it applied; a serve too old to
return one gets a warning and no `reason` in `--json`. A refusal shows the
server's message without its JSON (`src/cli/commands/workflow_cancel.ts`).
The CLI waits up to `SERVER_CANCEL_TIMEOUT_MS` for the answer: serve's grace
period for an aborted run, plus its longest sync-gate wait, plus a margin for
the suspended-run check that may follow. If it gets no answer, it says the
cancel may still complete on the server, and names the command to check.

When the daemon restarts, `swamp serve` reaps orphaned runs that the previous
process left in `running` state (`reapOrphanedWorkflowRuns` in
`src/domain/workflows/orphaned_run_reaper.ts`, called at serve boot). Each is interrupted with
`run.interrupt("server_crash")` (`src/domain/workflows/workflow_run.ts`). This
marks in-flight steps as `unknown` and the run as `interrupted`, tagged
with `interrupt_reason: server_crash`. Interrupted runs are recoverable; see
[Recovery](#recovery) below.

A local `workflow run` or `resume` that is force-exited (a second Ctrl-C
calls `Deno.exit(130)`) saves nothing, so its record stays `running` under a
dead pid. Local `swamp run doctor --fix` and `swamp workflow recover` interrupt
such a run when this host's run tracker shows its owner is gone, tagged
`interrupt_reason: owner_process_dead`; `swamp workflow resume` on it names
`workflow recover` (`settleDeadOwnerRun` in
`src/domain/workflows/orphaned_run_reaper.ts`; see
[run-tracker](../enablers/run-tracker.md)). `recover --assess-only` shows the
assessment for such a run without writing it.

A `RunCancelRegistry` in the serve layer tracks AbortControllers for every
execution path (scheduled, WebSocket ad-hoc, webhook). The cancel API checks
both the registry and the `ScheduledExecutionService` running map.

**Nested workflows.** Cancelling a run cancels the child runs its workflow
steps started. `runWorkflowStep` passes the step's abort signal to the child's
`run()`, so the child's steps stop and the child records itself cancelled. The
parent step fails, and the parent run is cancelled. After an abort, the job
runner stops reading a step's events, so the nested step drains the child
without forwarding its events. The parent waits for its nested steps to settle,
at most `CLEANUP_GRACE_TIMEOUT_MS`, before it records its own cancellation.
Only the child's terminal event is kept out of the parent's stream. Its other
events, including `started`, pass through. A nested `started` event carries
`parentRunId`, so the consumers that track a run by id act only on the started
event without it: the active-run registry rekey, `RunCancelRegistry`, the
scheduled and webhook runners, and the `workflow run` fallback cancel. A child
run is therefore not registered on its own, and serve cancels it through the
parent run's id. The registry does record each nested child against its parent
(`ActiveRunRegistry.addNestedRun`), but only `run.attach` resolves a child id
to the parent's entry (`findForAttach`). That keeps reconnects working for
clients that track the child's id. A `--server` client reattaches by the run it
started, skipping events that carry `parentRunId`. An older serve sends none
and keys the run on its latest nested child, so the client follows that id
there.

A parent suspended on a nested run is not a running parent: cancelling it
detaches the child rather than cancelling it (see "Gates inside a nested
workflow" above).

**Suspended runs.** A suspended run has no process driving it, so it is in
none of those registries. When they all miss, the cancel API falls back to a
persisted run: it finds the run by id alone among suspended runs, cancels it,
and saves (`cancelExecution` in `src/cli/commands/serve.ts`,
`cancelSuspendedRunAndPush` in `src/serve/suspended_run_cancel.ts`, and
`workflowCancelSuspended` in `src/libswamp/workflows/cancel_suspended.ts`).
This is how a run `swamp serve` started is cleared once it suspends. That
includes a run with an expired gate and one whose resume refuses a changed
workflow. A local cancel refuses such a run, and supersede skips it. Any serve
instance can cancel it, not only the one that started it, because each serve
start records a fresh `instanceId`. The endpoint's admin check still applies,
and the change runs under the sync gate and is pushed like any handler
mutation. A run that is already cancelled or finished gets `404`. A suspended
run that another operation holds gets `409`.

**Running runs whose owner is gone.** A serve process killed mid-step leaves
its run recorded `running` with no process driving it, and a local cancel
refuses a serve-owned run. The same fallback cancels it when the owner is shown
gone (`ownerGoneDecider` in `src/serve/suspended_run_cancel.ts`,
swamp-club#2518):

- A run this instance drives is in a registry and never reaches the fallback.
- A run with a run-tracker row from this host is judged on that row alone, by
  host and pid (`runHasDeadOwner` with `localOwnerLiveness`). Serve's own
  instance id is not used: the row a previous serve process left carries that process's
  instance id, so it would never count as local and the run would stay
  uncancellable until its heartbeat aged out.
- A run of another instance with no row from this host (none, or one written
  under another hostname, as after a container restart) is gone when the
  control plane holds no heartbeat for that instance while holding one for
  this instance. Its own heartbeat is how serve knows heartbeats are being
  recorded: without a control-plane-capable datastore it writes none, and a
  missing heartbeat then says nothing about an instance on another host.

`swamp run doctor` through serve (the `run.doctor` handler) uses the same
decision to call a `running` run of another instance orphaned, so it reports
and with `--fix` interrupts only a run whose owner is shown gone
(swamp-club#3059).

The run is then cancelled like an offline cancel of a run whose owner died:
its in-flight steps fail with "the process running this step stopped before
the step finished", its tracker row is completed `cancelled`, and the method
runs the dead process left `running` are settled, best effort. When the owner
cannot be shown gone, a caller allowed to cancel the run gets `409` and
nothing is written, since a live owner would save over the cancel. The reply
says what still holds the run and what to do, without naming a pid, host or
instance id:

- The process on the serve host is still alive: stop it, then cancel again.
- The serve instance that runs it still reports a heartbeat: cancel through
  that instance, or again here once its heartbeat has expired.
- Nothing can judge it: there is no tracker row from this host and no
  instance heartbeats to consult. No supported command clears such a run; `run doctor` applies
  the same owner checks, so it does not either.

A run aborted through `ActiveRunRegistry` is checked again once it leaves the
registry. A resume can save the run suspended at its next gate just before the
abort lands, and stay registered until its final push. Then the abort stopped
nothing, so the cancel falls through to the persisted suspended run and
cancels that. Only then does it report `cancelled`. If the run is still
registered after the grace period, the reply is `cancellation_requested`.

**Who cancelled.** Every run cancellation through serve is audited, and the
run records who made it. The HTTP single-run and bulk cancels, the WebSocket
`cancel` of a registered run, and `workflow.cancel` each emit one audit event:
category `execution`, action `cancel`, `cancel.all` or `workflow.cancel`, with
the principal and source IP, or `anonymous` without auth. A refused attempt is
audited too: the HTTP endpoint records `denied` when the caller lacks `admin`,
and the WebSocket paths record the access denial. The run's
`cancel_reason` names the same principal: `cancelled by user:alice`, or
`<reason> (cancelled by user:alice)` when the request gave a reason. For a run
in progress it travels as the abort reason passed to the registry that held it
(`ActiveRunRegistry`, `RunCancelRegistry`, or the scheduled runs); the executor
records the abort reason as `cancel_reason`. `cancelActor`,
`cancelReasonFor` and `emitRunCancelAudit` in `src/serve/handlers/shared.ts`
build both. `cancelActor` names the principal through
`resolveDisplayPrincipal`, as every serve audit event's `initiatedBy` does, so
the two cannot name a caller differently. The HTTP endpoint's `admin` check
and its `denied` audit are `authorizeCancelRequest` in
`src/cli/commands/serve.ts`.

Over WebSocket, the `workflow.cancel` request (`runId`, optional
`workflowIdOrName` and `reason`) cancels a run in `ActiveRunRegistry` (one
started or resumed over WebSocket, or auto-resumed) or a persisted run:
suspended, or left `running` by an owner that is gone. Scheduled and webhook
runs are held in `RunCancelRegistry` and the scheduled runs instead, so they
are cancelled over HTTP. It is not gated at
dispatch: it waits for an aborted run, which needs the sync gate for its final
push, so it takes the gate only for the persisted cancel and its push
(`cancelSuspendedRunAndPush`). It finds the persisted run and authorizes the
caller before taking the gate, so a refused or unknown run id never holds it
(swamp-club#2648). The lookup is cheap whatever the caller sends: a run id that
is not a UUID is not found without a repository read, and any other is loaded
from its own run file alone. `workflowIdOrName` is compared with the
found run's workflow rather than resolved first, so an unknown name reads no
workflow files (swamp-club#2729). It authorizes the `run` action on the
workflow the run belongs to, as the server knows it, never the payload's name.
So does the bare `cancel` when its id names a run in the registry rather than
one of the connection's own requests. By design, any principal with `run` on a
workflow may cancel that workflow's runs, including ones other principals
started. The audit event and `cancel_reason` record who did.
`workflow.cancel` checks without replying (`isAuthorized` in
`src/serve/handlers/shared.ts`). A refused caller, a missing run, and a run of
another workflow than the payload names all get the same
`No cancellable run with id <id>` error. The bare `cancel` sends no reply when
it aborts. For one of the connection's own requests it only aborts that
request, which detaches its stream. A refused bare `cancel` of a registered run
gets no reply either, like an unknown id, so it never confirms the run exists
or names its workflow; the denial, including a missing policy snapshot or
principal, goes only to the audit log.

Within one serve process, the cancel serializes with a resume, approve or
reject of the same run through `ActiveRunRegistry.reserve`. That is a claim on
the run id that makes `register` refuse it until released; it is released in a
`finally`. The cancel finds and authorizes the run first, then reserves the id
and reads the run again before it saves, so it never saves over a resume. Only
an allowed caller reserves, so a refused one can neither hold the run nor
learn from the busy reply that it exists (swamp-club#2649). A resume that
registered first is aborted through the registry instead. A resume that read
the run before the cancel re-reads it, finds it cancelled, and refuses.
Approve and reject reserve the run they resolved, so an approval cannot put a
cancelled run back to `suspended` and auto-resume it. An operation refused by
a reservation gets "Another operation on this run is in progress; try again".
A local CLI resume or approve, or a second serve instance on a shared
datastore, is not covered by the reservation.

Model method runs cancel the same way, with
`swamp model cancel <model> [--all] [--reason <reason>]`. The command SIGTERMs
the process that owns the method run and waits up to 10 s for it to exit
before SIGKILL: the 3 s grace the shell step gets, plus time for the owner to
save the cancelled output (`METHOD_OWNER_STOP_GRACE_MS`,
`src/cli/commands/model_cancel.ts`). A process that also owns a running
workflow run, as a workflow step's method run does, gets the workflow cancel
grace instead, so its cleanup steps can run. `--all` stops the owning
processes together, each once. A run its owner finished another way during
the wait keeps that status, and the command reports it as finished before the
cancel took effect (`finished` in `--json`) rather than as cancelled.
A step's method run that a cancel stops records `cancelled`, in its method-run
output and its tracker row, as a standalone method run does; the step itself
is still recorded failed (`DefaultStepExecutor`,
`src/domain/workflows/execution_service.ts`). When the owner is killed after
its grace instead, the method-run output it left `running` is cancelled by the
command, with `OWNER_STOPPED_STEP_ERROR`, before the row is completed.
`swamp model cancel` never signals a `swamp serve` process. A method run that
serve executes (a workflow step or a direct method run) carries serve's
instance id on its tracker row and serve's pid, so stopping its owner would
shut down the whole server. While that serve is alive, `--all` skips such runs
and lists them (`skipped` in `--json`, always present), and the named form
cancels the latest run serve does not own, listing the rest under `skipped`
too, or refuses when serve owns them all. Cancel a serve-owned step through its
workflow run on the server; a direct method run stops only from the client
that started it. A step row sharing its pid and host with a serve-owned
workflow row counts as serve-owned too, for rows an older serve wrote without
an instance id. A serve-owned run whose serve is a dead process on this host
is cancelled normally, as there is no process left to signal; a run from
another host is always treated as live (`splitServeOwnedRuns`,
`src/cli/commands/model_cancel.ts`).

### Post-Cancellation Cleanup

When a workflow is cancelled (by `--timeout`, Ctrl+C, or `swamp workflow
cancel`) and the cancellation stops an in-flight step or interrupts a level,
steps with `always`, `completed` or `failed` dependency conditions still run,
so cleanup branches (notifications, resource teardown, metric reporting,
rollback) can run. The engine evaluates the remaining steps in topological
order:

- Steps whose dependency conditions are met run with a fresh 30-second cleanup
  signal. `always` is true unconditionally; `completed` is true when the
  dependency reached `succeeded` or `failed`. A cleanup step's model method
  that the 30 seconds cut off saves its method run `cancelled` with the cause
  `cleanup grace expired`.
- Steps whose conditions are not met (`succeeded` on a failed dependency) are
  skipped.
- An in-flight step stopped by the cancellation signal is marked `failed`. A
  step alone in its level is waited for, so it records the error its stopped
  method reported (for `command/shell`, the killed subprocess's exit). A level
  holding several steps does not wait for them once the cancellation fires, so
  each step it leaves `running` is marked `failed` with reason `cancelled`.
  Their model methods go on stopping, and before it saves its cancelled
  record the run waits for them, and for any guard or assert
  `model.method()` call still in flight, until `STEP_STOP_GRACE_MS` (4 s)
  after the cancellation. Each method therefore saves its method run
  `cancelled` before `swamp workflow run` pushes its data and exits. The method
  run's error message is the cause of the cancel (`cancelCause` in
  `src/domain/models/cancel_cause.ts`): `timed out` when the run's `--timeout`
  stopped it, the reason a cancel through serve or the scheduler gave, or
  `aborted` for a cancel that named none. A method
  still running after that keeps its method run `running` (swamp-club#2918),
  as does any method whose owner was killed. The wait counts from the
  cancellation, so a run whose cleanup steps outlast it does not wait at all.
  Nothing settles such a record yet; reaping method runs left `running` by a
  dead owner is swamp-club#2930.
  A method that answers late does not change the step: it stays `failed` with
  reason `cancelled`, while its method run records what the method did.
- Steps, `forEach` iterations and jobs that the interrupted level never started
  (queued behind a `concurrency` limit) are settled at the end of that level as
  if they had been reached: skipped when their `dependsOn` is not met (reason
  `dependency` for a step; a skipped job's steps get `job_skipped`), otherwise
  marked `failed` with reason `cancelled` and no `startedAt`. A `forEach`
  dependency with a queued iteration therefore aggregates to `failed`, and
  cleanup gated on it runs. A `failed`-gated rollback can run for work that
  never started, so it must tolerate having nothing to undo.
- A never-started step that has a `guard` stays `pending` (undecided): its
  guard never decided whether the step's work was already done.
  `succeeded`, `failed`, `completed` and `skipped` are all false for a
  `pending` step, and a `forEach` with an undecided iteration aggregates to
  `running`, so neither a `failed`-gated rollback nor a `succeeded`-gated next
  step runs on it; `always` still does, and so does a `not` condition, which
  is true on a `pending` step. An undecided step remains `pending` in the
  cancelled run's record.
- A step whose guard was being evaluated when the cancellation fired does not
  start and stays undecided, whatever the guard answers: the level may already
  have moved on. A step recorded `running` when its run resumes starts as
  before.
- A started job left with an undecided step still runs its later levels in
  cleanup mode. If nothing in it failed, it ends `unknown`: its outcome is
  ambiguous, so neither a `failed`-gated teardown job nor a `succeeded`-gated
  next job runs on it (a `not` condition does), and it gets no
  `job_completed` event. A job that also had a failure ends `failed`, as
  before.
- A started job finishes the same way whether or not it shares its level: a
  level holding several jobs waits for each started job to run its cleanup
  and reach its outcome. The cancelled record is therefore written once that
  cleanup has finished. Each cleanup level is bounded by its 30-second
  cleanup signal, but a method that ignores its signal delays the record, as
  it would for a job alone in its level.
- A job whose level is reached after the cancellation fired, without cleanup
  mode, never starts, whether or not it shares its level (swamp-club#2898):
  none of its steps is invoked with the cancelled signal, and it is settled as
  a never-started job when the run records its cancellation.
- A never-started job settles its steps in dependency order, each as above.
  It stays `pending` while any step is undecided, even when another step was
  cancelled, since nothing in it ran; otherwise it fails when any step failed
  and is skipped when every step was skipped.
- Settled steps and jobs get no `step_failed`, `step_skipped`, `job_skipped`
  or `job_completed` event; the run record carries their outcome, and marks
  each settled step `settledByAbort`.
- `workflow resume` applies the same step- and job-level cleanup when its own
  cancellation interrupts a level: later job levels run with the cleanup
  signal, and it settles never-started steps and jobs the same way
  (swamp-club#2550). A job that failed before the resume counts once the
  resume reaches its level. A job the run was suspended in is unfinished work:
  one in a later level runs with the cleanup signal when its level is reached.
  One the cancellation kept from starting (the abort fired before its level,
  or while it was queued behind `concurrency`) is settled when its level
  ends, so it never stays `running` in the cancelled record (swamp-club#2597),
  alone in its level or not (swamp-club#2898).
  Its pending steps are settled as a never-started job's, then the job ends
  `failed` when a step failed and that failure was not allowed, `unknown`
  while a guarded step is undecided, otherwise `succeeded`. A `failed` or
  `unknown` job starts cleanup mode, so an `always` or `completed` teardown on
  it runs only after it is settled, never ahead of approved work still
  recorded as running. The same holds for a job a failed run left `running`
  when a `--from` resume is cancelled before reaching it (a retry refuses a
  run with a pending step).
- A resume of the run runs the work its abort settled, as it would have run
  the `pending` records. This holds for a plain resume, one after `workflow
  recover` or an approval, and a retry or `--from`. Each settled step is reset
  to `pending` record by record, so a step with the same name in another job
  is left alone, and a finished job holding one is walked again. So is a job
  the cancellation ended `unknown` with an undecided step. A step or job that
  cleanup skipped on its `dependsOn` never ran, so it counts as settled too
  and is evaluated again: a `succeeded`-gated dependent of a cancelled or
  undecided step runs once that step succeeds. Cleanup that already ran for
  that work is not run again: when cleanup suspends at a gate after settling
  a job the resume never started, a later resume runs that job's approved
  work after the cleanup's earlier steps already ran. A retry still needs
  every step finished, so a failed run with an undecided step is resumed with
  `--from`.
- A step that already failed stays failed on resume. When resume walks its job
  again, the job ends `failed` unless that failure was allowed, so the run
  ends `failed` and can be retried. An in-flight step the cancellation stopped
  is such a step.
- A level that suspends at an approval gate keeps its queued steps `pending`,
  so the run can be resumed.

Known limitation: cleanup mode starts only after something in the interrupted
level failed or was left undecided. When every step of that level finishes
successfully despite the cancellation (a method that ignores the signal), a
later step level of that job is reached with the cancellation already fired
and never enters cleanup mode: a level holding one step runs it with the
aborted signal, and a level holding several starts nothing and leaves them
`pending`. A later job level starts nothing, as above.

The same applies after a normal step failure without cancellation. Steps with
`always` or `completed` conditions in later topological levels run instead of
being skipped.

The `--timeout` flag kills in-flight subprocesses when the deadline passes,
then runs cleanup steps. Values above about 24.8 days are rejected, because Deno
fires a longer timer after 1 ms (`parseTimerDuration`,
`src/cli/duration_parser.ts`).

Every abort of a `command/shell` step (`--timeout`, the step's own `timeout`,
Ctrl-C, `swamp workflow cancel`, serve shutdown) sends SIGTERM, then SIGKILL
after a 3 s grace to whatever is still alive. The step settles once that is
done, so it takes no longer than the grace however the command handles SIGTERM
(`executeProcess`, `src/infrastructure/process/process_executor.ts`). What is
signalled depends on whether swamp has a controlling terminal
(`src/infrastructure/process/process_group_policy.ts`):

- **No terminal (CI, agents, system services), and always under `swamp serve`
  and the worker `exec-dispatch` runner**: the command runs in its own session
  and process group, and the whole group is signalled, so nothing the step
  started outlives it. As a consequence, a step cannot open `/dev/tty`.
  Prompts that need it (a `sudo` password, an ssh host key) fail instead of
  waiting; use `sudo -S` or askpass, ssh `BatchMode`, or credential helpers.
  Any group still alive when swamp calls `Deno.exit` gets SIGKILL, and an
  offline cancel sends SIGKILL to the groups of the process it stops. The
  groups are outside swamp's own process group, so a supervisor that
  SIGKILLs swamp or its group directly (`timeout -s KILL`, `kill -9 -- -pgid`)
  leaves them running; stop swamp with SIGTERM or SIGINT so it terminates
  them. In a container, run swamp under an init so the processes it kills
  are reaped: Linux re-parents them to PID 1, and swamp waits only on the
  children it spawned itself. A zombie still counts as a group member, so
  without an init every cancel also waits the full grace. The official image
  runs swamp under its base image's tini as a child subreaper
  (`/tini -s -- swamp`); an image that runs swamp directly needs
  `docker run --init` or tini. `swamp serve` and `swamp worker connect` log a
  warning (log mode only) when they run as PID 1 on Linux.
- **Interactive terminal**: the command stays in the terminal's foreground
  group, so it keeps `/dev/tty` prompts, and Ctrl-C reaches every process it
  started. A timeout or offline cancel signals only the direct child, so its
  own children can outlive the step.
- **Windows**: `taskkill /T /F` ends the whole tree.

A step whose command exits on its own is never signalled: anything it
deliberately backgrounded keeps running.

### Recovery

When a serve instance crashes during a run, or a run's owning process dies, the
run is marked `interrupted` and its in-flight steps `unknown`. An `unknown` step was running at crash time, so
its outcome is unclear: it may have completed externally without Swamp
recording the result.

**Step-boundary checkpoints:** the run is saved each time a step starts and
each time it reaches a terminal state (succeeded, failed, skipped), not only at
topological level boundaries, so a crash mid-level keeps that level's completed
steps, and a step that was running when the process died is recorded `running`
and becomes `unknown`, never `pending`, when the run is interrupted. A record
written by a swamp that did not save step starts, or a kill that beat the save,
can still show the in-flight step `pending`. So when a dead owner's run is
interrupted (`WorkflowRun.interruptOrphaned`), a job left `running` with no step
recorded `running` has its `pending` steps marked `unknown` too, and recovery
asks before re-running them.

**Run plan identity:** at run start, the run plan records two fingerprints: one
of the definition as loaded from disk (`definitionFingerprint`), and one of the
evaluated workflow (`fingerprint`), whose per-run snapshot is stored in
`.swamp/workflows-evaluated/runs/{runId}/`. Evaluation resolves expressions such
as `inputs.*`, so the evaluated fingerprint also changes with the run's inputs.
The snapshot shares its run's lifetime: `swamp run gc` removes it with the run
(and sweeps orphaned snapshots older than retention), and `swamp workflow
delete` removes the snapshots of the runs it deletes.
On recovery, the current definition's fingerprint is compared with the stored
definition fingerprint. If they differ, recovery is refused, and the refusal
tells the operator to start a new run with `swamp workflow run`. There is no
way yet to continue the interrupted run itself: `resume --from` accepts failed
runs, not interrupted ones (swamp-club#2443).

A run recorded before runs stored a definition fingerprint has only the
evaluated one. Recovery compares that with the current definition, which matches
only when evaluation left the definition unchanged, and refuses on any
difference, with the same next step, because a difference cannot be told apart
from a changed definition. A run re-saved by an older swamp loses its definition
fingerprint, because older versions drop run-plan keys they do not know, and is
handled the same way. Runs started with `--last-evaluated` record no run plan,
and recovery skips the check for them. For such a run, the resume that
`workflow recover` prints still runs the suspended-run
[structure check](#resume-from-failed-step---from). If the workflow changed
shape, that resume refuses and the run, now `suspended`, has to be cancelled,
or the change reverted when serve started it.
Recover itself does not run the check: an interrupted run cannot be cancelled,
and `recover --assess-only` would disagree with it.

**Recovery assessment (`swamp workflow recover --assess-only`):** classifies
each `unknown` step as auto-recoverable (it has a `guard` expression) or
requires-acknowledgement (no guard). A guarded step is safe to re-run, because
the guard skips it if the work was already done.

**Recovery flow:**

1. `swamp workflow recover <workflow>` (a workflow name or ID) assesses the
   interrupted run. If every unknown step has a guard and the fingerprints
   match, it resets unknown steps to `pending` and moves the run to
   `suspended`.
2. `swamp workflow resume <workflow> --run <id>` re-enters the executor. Each
   reset step's guard is evaluated: truthy (the work finished before the crash)
   skips the step, otherwise it runs again.

When unknown steps have no guards, `--acknowledge-unknown` accepts the risk of
re-running steps whose external side effects may already have happened.

**Non-goals:** recovery does not promise exactly-once execution. A crash can
happen after an external side effect succeeds but before Swamp records the step
as complete. The `unknown` status makes this visible.

## Domain Events

The WorkflowRepository and WorkflowRunRepository emit domain events:

**Workflow Events:**

- `WorkflowCreated`: a new workflow is created with `workflow create`
- `WorkflowUpdated`: a workflow definition is modified
- `WorkflowDeleted`: a workflow is deleted

**WorkflowRun Events:**

- `WorkflowRunStarted`: `workflow run` begins execution
- `WorkflowRunCompleted`: a workflow run completes successfully
- `WorkflowRunFailed`: a workflow run fails

The RepoIndexService subscribes to these events (currently a no-op
implementation). See [repo](../surfaces/repo.md) for more on domain events.

## Per-Method Telemetry

A workflow run emits one parent telemetry entry for the outer
`swamp workflow run` invocation. It also emits one child entry per workflow YAML
step that resolves to a model method. Each child links to the parent through
`parentInvocationId` and carries a `workflowContext` block:

```yaml
workflowContext:
  workflowName: deploy
  runId: <workflow-run-uuid>
  jobName: build
  stepName: validate-config
  modelType: command/shell
  executor: loopback
```

Children use the same `cli_invocation` event shape as a direct
`swamp model method run <name> <method>` invocation: `command="model"`,
`subcommand="method"`, `args=["run", <modelName>, <methodName>]` and
`commandPath=["model", "method", "run"]`. Analytics that group by command or
method therefore count direct and workflow-internal invocations the same way.
Per-executor and per-model-type queries read `workflowContext` directly, without
joining through the parent.

### Failure Semantics

- A step that fails after `method_executing` was yielded records an error child
  entry with the measured duration.
- A step that fails before `method_executing` (model lookup failure, vault
  expression resolution failure, vary-key validation failure, env-var
  validation) records a synthesized child entry with `durationMs = 0`. The
  method was never invoked, so its duration is zero. Dashboards that filter
  out zero-duration entries will hide these validation failures; this is
  expected.
- A step with `allowFailure: true` records `error` in the child entry (the
  method outcome). The parent records the overall workflow outcome: `success`
  if there were no unallowed failures. Joining
  `child.error_category × parent.success` on `parentInvocationId` shows how
  many failures were allowed, without changing the entry shape.

### V1 Limitations

- **Workflow-step granularity only.** Follow-up calls inside
  `DefaultMethodExecutionService.execute` (e.g. a method that internally
  invokes another method) are not captured as separate child entries. The
  workflow step is the unit of measurement.
- **Workflow-task steps** (steps whose task is a nested workflow) emit no child
  entry of their own. The nested workflow's model-method steps produce child
  entries linked to the same parent CLI invocation. At any nesting depth, those
  entries carry the top-level run's `workflowName` and `runId`, with the nested
  workflow's own `jobName` and `stepName`. The bridge pairs a step's
  `method_executing` with its terminal event by the run that owns the step as
  well as its job and step names. So a nested step whose names repeat those of
  a step running concurrently in the parent, or in a sibling nested run, still
  records its own entry. That owning-run id is on the domain step events only;
  it is not part of the published workflow run event stream.
- **Failures before workflow validation** (e.g. workflow not found, input
  schema validation) produce no child entry, because no method was resolved.
- **Cancellation** during a method invocation (AbortSignal, timeout) records
  the in-flight method as an error child entry through the bridge's finalize
  path, with a synthetic "workflow run terminated before completion" message.

The bridge lives in `src/libswamp/workflows/telemetry_bridge.ts`. The domain
`step_failed` event has optional `modelName` and `methodName` fields, set only
at the model-method failure site. Other yield sites (nesting depth, cycle
detection, nested-workflow failure) leave them undefined, so the bridge can tell
structural failures from method failures.

### Runs Executed by `swamp serve`

Scheduled, webhook, and API-triggered runs record the same parent and child
entries as an interactive `swamp workflow run`, with two differences.

**The parent is the run, not the process.** The CLI allocates one invocation id
per process, because one CLI process is one invocation. A daemon's own
process-level entry is not written until it exits, possibly weeks later, so
children attached to it would have a dangling `parentInvocationId` for its whole
uptime. Instead, each serve-executed run forks its own service
(`TelemetryService.forkForRun`) and records a per-run parent shaped like the
`swamp workflow run` invocation it stands in for, with the workflow name in
`args` as the CLI sends it.

**Entries carry a `triggerSource`** of `schedule`, `webhook`, or `api`.
Interactive runs leave it unset, so their events are unchanged. The field is
not called `source` because the telemetry backend derives a field by that name
from the recorded command, and reusing it would mix two separately owned
concerns.

A run reports failure through its event stream, not by throwing: input
validation, a failed step, and cancellation all return normally. So the outcome
is read from the stream, and a run that did not reach `succeeded` records an
error parent. This matters because only successful invocations are counted
downstream.

The composition lives in `src/serve/telemetry.ts`. The sink is passed through
`executeWorkflowWithLocks` in `src/serve/deps.ts`, the single path all three
trigger types share. Callers that supply no trigger source (libswamp consumers,
tests) produce no telemetry.
