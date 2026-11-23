# Remote Execution: Workers and Step Placement

Remote execution fans workflow steps out across **workers** — disposable swamp
processes that dial home to an orchestrator (`swamp serve`), enroll with a
token, and execute dispatched method bodies with every capability proxied back
to the orchestrator. It replaces the removed execution-driver abstraction
(`driver:`/`driverConfig:` fields no longer exist); for isolation, run a
containerized worker and select it with labels. Full design:
`design/enablers/remote-execution.md`.

Contents: [Provisioning a worker](#provisioning-a-worker) ·
[Placing steps on workers](#placing-steps-on-workers) ·
[Fan-out jobs](#fan-out-jobs-fanout-one-lane-per-matching-worker) ·
[Affinity](#affinity-worker-co-location) · [Remote-only mode](#remote-only-mode)
·
[Running through the orchestrator](#running-workflows-through-the-orchestrator)
· [Semantics](#semantics-worth-knowing)

## Provisioning a worker

On or near the orchestrator (an initialized swamp repo with a vault):

```bash
swamp worker token create ci-runner-3 --duration 1h   # prints <name>.<secret> ONCE
```

On the worker host (no swamp repo needed — just the binary):

```bash
swamp worker connect ws://orchestrator.internal:4000 \
  --token <name>.<secret> \
  --label region=us-east --label gpu=true
```

The token enrolls exactly one machine, binding to a `machine-id` file in the
worker's cache directory; that machine re-authenticates across socket blips,
restarts, and reboots until the token lifetime expires, while any other machine
is rejected. `--duration` is a hard deadline — when it elapses the orchestrator
disconnects the worker and rejects re-enrollment. To keep a worker past it, run
`swamp worker token rotate <name> --server <url>` before it lapses: the token
keeps its name (so the worker keeps its own), connected workers receive the new
secret over their connection, and one started with `--token-file` writes it back
to that file. The old secret keeps working until its original expiry, and the
command lists workers it could not rotate. A rotation run by a workflow step or
schedule on serve reaches connected workers as soon as the step finishes; one
made without `--server` from another process waits for serve's next token check
(about 30 seconds), so use `--server` when the old token expires within about 40
seconds. Without `durationMs` (or `--duration`) the new token gets the token's
lifetime plus the old token's remaining time, up to a tenth of the lifetime (at
least 40 seconds), so a schedule as long as the lifetime never lets the token
lapse; an explicit duration counts from the rotation. Only `--server` reports
the workers a rotation missed. Rotating again retires the old secret at once,
even for workers not yet reached, so if the new token is lost, read it back with
`swamp worker token reveal <name>` instead. Pass a stable `--cache-dir` to keep
the machine identity across restarts — the default temp cache directory yields a
fresh identity (and thus needs a fresh token) per process. A token's secret is
never released to a dispatched step, whatever vault holds it
(`reserved_secret`), so deliver a token to its host outside workflows. Manage
tokens with `swamp worker token list`, `swamp worker token rotate <name>`,
`swamp worker token reveal <name>` and `swamp worker token revoke <name>`;
inspect the pool with `swamp worker list`, or visually in the dashboard's
Workers view (`/dashboard/workers` on a serve started with `--dashboard`):
workers grouped by label, per-slot lease state, and a selector box that shows
where a step's placement would land.

## Placing steps on workers

Placement fields (`target`, `labels`, `platform`, `queueTimeout`) can be set at
the **workflow**, **job**, or **step** level. Steps without any effective
placement run locally; steps with placement dispatch to a matching worker.

Inheritance: workflow-level placement applies to all steps as a default,
job-level overrides workflow, step-level overrides job. An explicit empty value
(e.g., `labels: {}`) clears inherited placement for that field.

Nested workflows inherit too: a child's steps run where the step that calls it
would run, with its affinity pin. On the calling step, `target`, `labels` or
`platform` place that child, and `placement: own` hands nothing down (the child
uses only its own YAML; unplaced, it runs locally). Decided per child step: a
step whose workflow, job or own fields set `target`, `labels` or `platform`
(`labels: {}` included) is placed only by them. See
[nested-workflows.md](nested-workflows.md#placement-on-workers).

```yaml
name: deploy-pipeline
labels:
  pool: gke
  fleet: platform-fleet-v3

jobs:
  - name: build
    steps:
      - name: compile
        task: ... # inherits workflow labels
      - name: test
        task: ... # inherits workflow labels
  - name: report
    labels: {} # override: run all steps locally
    steps:
      - name: summarize
        task: ... # no placement — runs locally
  - name: gpu-work
    steps:
      - name: train
        target: gpu-box-1 # step overrides: pin to specific worker
        task: ...
```

Step-level placement:

```yaml
steps:
  - name: train
    target: gpu-box-1 # pin to a worker by token name or instance uuid
    task: ...
  - name: build
    labels: # every entry must match the worker's labels
      region: us-east
      gpu: "true"
    platform: linux/x86_64 # "os" or "os/arch"
    task: ...
```

Matching order: `target` → `labels` → `platform`; idle eligible workers win,
all-busy queues the step, and no eligible worker fails the step fast. To run a
job once on **every** matching host (a fleet), use a `fanOut` job (next
section), not `forEach` over the worker list: `fanOut` plans the hosts once,
waits for offline ones, and a resume keeps the hosts that passed. Keep `forEach`
for loops over data (environments, regions, files); its instances spread across
matching workers, each worker running one dispatch at a time.

## Fan-out jobs (`fanOut`): one lane per matching worker

A job with `fanOut` runs once on every connected worker its `labels` /
`platform` select, as a **lane** pinned to that worker. Use it for fleet work:
push a config, rotate a certificate, update a package on every web host.

| Goal                                       | Use                            |
| ------------------------------------------ | ------------------------------ |
| Run steps on one matching worker           | placement (`labels`, `target`) |
| Run a job on **every** matching worker     | `fanOut` on the job            |
| Loop over data (envs, regions, files)      | `forEach` on a step            |
| Stage hosts, stop on failures, ask a human | `fanOut` with `rollout`        |

### Fields

```yaml
jobs:
  - name: patch
    labels: { role: web } # the selector: job (or workflow) labels/platform
    fanOut: # or the short form: fanOut: all (every default)
      offline: wait # wait (default) | skip | fail, for hosts not connected
      minWorkers: 2 # default 1; fewer live members refuses the plan
      rollout: # optional; without it every lane runs at once
        batches: [1, "25%", "100%"] # count or whole %; the last must be "100%"
        maxFailures: 1 # count, or "10%" of planned lanes (rounds down)
        approve: [plan, canary] # optional gates
        approveTimeout: 3600 # seconds; needs approve
    steps: ...
```

- **Selector.** The job's `labels` / `platform` after inheritance from the
  workflow. `fanOut` is job-level only and needs one of them: to reach every
  worker, give them a shared label and select it.
- **Lanes.** Each lane walks the job's steps on its own. A lane step is recorded
  as `step[worker]`, e.g. `apply[web-01]`. `dependsOn`, guards and
  `steps.<name>` inside a lane read only that lane. A later job cannot read a
  fan-out job's `steps.<name>`; read lane results through data.
- **`self.worker`** (`name`, `labels`, `platform`, `arch`) is in scope in every
  step's guard, inputs and global arguments.
- **Per-worker instances.** Use `behaviorType` + `behaviorName`. The name gets a
  `-<worker>` suffix (`nginx-config` → `nginx-config-web-01`), unless its
  authored text uses `self.worker.name`, so locks and data are per host.
- **Per-host checks.** Put `assert` steps inside the lane; they run on the
  orchestrator against what that lane's host wrote. A failed assertion of the
  default `high` severity fails the lane.
- **Outcome.** A lane fails when a step fails without `allowFailure`. The job
  succeeds only if every lane does and no member failed at plan time.
- **Rollout.** Batch N+1 starts only once every lane of earlier batches has
  finished. Once failed lanes exceed `maxFailures`, no new lane starts (running
  lanes finish), the rest are **held**, and the job fails. There is no bake time
  between batches; use `approve: [canary]` to pause after the first batch.
- **Gates.** `approve: [plan]` asks before any lane starts; `approve: [canary]`
  asks after the first batch (needs a second batch). Gates are approval steps
  named `job[approve-plan]` / `job[approve-canary]`; approve or reject them like
  any gate (`swamp workflow approve <workflow> patch[approve-canary]`). The
  `swamp workflow approvals` listing shows the approver the plan or the canary
  results. Reject is final for the run.
- **Resume.** A resume never re-plans: it reuses the stored members and batches,
  keeps every lane that passed, and re-runs the rest, starting with the lanes
  the last halt failed. The budget is fresh for the resumed attempt. To re-run a
  passed host, start a new run.
- **Needs serve.** Run fan-out workflows with `--server` (see "Running workflows
  through the orchestrator").

### Example: config push with a per-host health check

```yaml
name: push-nginx-config
jobs:
  - name: push
    labels: { role: web }
    fanOut: all
    steps:
      - name: write-config
        task:
          type: behavior
          behaviorType: command/shell
          behaviorName: nginx-config
          methodName: execute
          inputs:
            run: "install -m 644 /srv/config/nginx.conf /etc/nginx/nginx.conf && nginx -s reload"
      - name: health
        dependsOn:
          - step: write-config
            condition: { type: succeeded }
        task:
          type: behavior
          behaviorType: command/shell
          behaviorName: nginx-health
          methodName: execute
          inputs:
            run: "curl -fsS http://localhost/healthz"
      - name: healthy
        dependsOn:
          - step: health
            condition: { type: succeeded }
        task:
          type: assert
          expr: 'steps.health.outputs.stdout.contains("ok")'
          message: "health check failed on this host"
```

### Example: staged package update with plan approval, canary and budget

```yaml
name: update-openssl
jobs:
  - name: update
    labels: { role: web }
    queueTimeout: 600 # how long a lane waits for its worker
    fanOut:
      offline: wait
      minWorkers: 3
      rollout:
        batches: [1, "50%", "100%"] # one canary host, half, then the rest
        maxFailures: "10%"
        approve: [plan, canary]
        approveTimeout: 86400
    steps:
      - name: upgrade
        task:
          type: behavior
          behaviorType: command/shell
          behaviorName: openssl-upgrade
          methodName: execute
          inputs:
            run: "apt-get install -y --only-upgrade openssl"
      - name: version
        dependsOn:
          - step: upgrade
            condition: { type: succeeded }
        task:
          type: behavior
          behaviorType: command/shell
          behaviorName: openssl-version
          methodName: execute
          inputs:
            run: "openssl version"
      - name: patched
        dependsOn:
          - step: version
            condition: { type: succeeded }
        task:
          type: assert
          expr: 'steps.version.outputs.stdout.contains("3.0.13")'
          message: "openssl is not at 3.0.13"
```

Run it: `swamp workflow run update-openssl --server <url>`. It suspends at
`update[approve-plan]`; after approval the canary host runs and the run suspends
at `update[approve-canary]`.

### Restarting the host from a lane

A step that restarts its own host schedules the restart and returns (e.g.
`shutdown -r +1`), so the step finishes before the worker goes down. Run the
worker as a daemon with a stable `--cache-dir`
(`swamp worker daemon enable <url> --token-file <path> --cache-dir <dir>`) so it
comes back under the same identity, and give the next step a `queueTimeout` long
enough to cover the reboot: a lane waits for its own worker by name.

### Before fanning out: environment and workspaces

- **Workers get serve's environment unless `dispatch-env-allow` is set.** Unset,
  every dispatch ships serve's whole environment minus the denylist (`HOME`,
  `PATH`, `USER`, `SHELL`, `SWAMP_*`, `DENO_*`, `OTEL_*`, `XDG_*` and similar),
  and fan-out sends it to every matching host. Set the allow list to the
  variables the steps need:
  `swamp serve --dispatch-env-allow AWS_REGION,APP_ENV`, `dispatch-env-allow:`
  in `serve.yaml`, or `SWAMP_DISPATCH_ENV_ALLOW`. An empty list
  (`dispatch-env-allow: []`) ships nothing. Each hosted workspace sets its own.
- **Fan-out is per workspace.** Under `swamp serve host`, each workspace is its
  own serve at `<host>/w/<name>`, and a worker belongs to the workspace whose
  address it connects to. A `fanOut` job reaches only that workspace's workers;
  a machine serving two workspaces runs two workers, each with its own token,
  `--cache-dir` and address.

### Refusals and fixes

`swamp workflow validate` reports these (`<job>` / `<step>` stand for names):

| Message (start)                                                                               | Fix                                                                                  |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `Fan-out job '<job>' sets target, which names one worker.`                                    | Remove `target`; select with `labels` / `platform`                                   |
| `The workflow sets target, which fan-out job '<job>' would inherit`                           | Move `target` off the workflow onto the jobs that need it                            |
| `Fan-out job '<job>' has no labels or platform in effect.`                                    | Add `labels` or `platform` to the job or workflow (`labels: {}` counts as none)      |
| `Fan-out job '<job>' sets affinity: true`                                                     | Remove `affinity` from the job                                                       |
| `The workflow sets affinity: true, which would pin fan-out job '<job>' to one worker.`        | Set `affinity: false` on the fan-out job, or drop workflow affinity                  |
| `Step '<step>' in fan-out job '<job>' sets labels, but each lane runs on one worker.`         | Remove step `target` / `labels` / `platform`; place the job (`queueTimeout` is fine) |
| `... uses forEach, which fan-out jobs do not support yet.`                                    | Move the loop into a job without `fanOut`                                            |
| `... runs the named definition '<name>', which every lane would share.`                       | Use `behaviorType` + `behaviorName`                                                  |
| `... is a manual_approval step` / `a wait_for_signal` / `a nested workflow`                   | Move it to another job; ask for approval with `rollout.approve`                      |
| `... has the name of the job's plan approval gate.`                                           | Rename the step                                                                      |
| `approve: canary needs a batch after the canary; add batches, for example [1, 100%]`          | Add a batch after the canary                                                         |
| `approveTimeout needs approve: plan, canary, or both`                                         | Add `approve` or drop `approveTimeout`                                               |
| `The last batch must be "100%" (the rest of the lanes)` / `Only the last batch may be "100%"` | End `batches` with `"100%"`, and only there                                          |
| `Expected a whole percentage from 1% to 100%` (0% for `maxFailures`)                          | Use a count or a whole percentage string such as `"25%"`                             |

At run time:

| Message (start)                                                                                                          | Fix                                                         |
| ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `Workflow '<wf>' has fan-out job '<job>': fanOut needs the worker pool of swamp serve; run it with --server.`            | Run, resume or recover with `--server <url>`                |
| `Fan-out job '<job>' needs at least N workers matching ... that are connected or waiting, and M are; nothing was sent.`  | Connect workers with matching labels, or lower `minWorkers` |
| `Fan-out job '<job>' cannot name its lanes: worker 'approve-plan' has the name its plan approval gate takes.`            | Rename the worker or remove that gate from `approve`        |
| `Fan-out job '<job>' cannot name its lanes: step '<step>' on worker '<w>' gives '<name>' ...`                            | Rename the step or the worker                               |
| `Fan-out job '<job>' would run behavior '<a>' on worker '<w1>' and behavior '<b>' on worker '<w2>' as the same instance` | Rename one of the behaviors                                 |
| `Worker '<w>' of fan-out job '<job>' is not connected, and the job's offline policy is skip; nothing was sent.`          | On resume: reconnect the worker, or start a new run         |
| `Fan-out job "<job>" selects different workers than when the run began: its labels or platform changed.`                 | Resume refused: restore the selector, or start a new run    |
| `Job "<job>" ran as a fan-out job, and the workflow no longer sets fanOut on it.`                                        | Restore `fanOut`, or start a new run                        |
| `Job "<job>" has fanOut but its run holds no fan-out plan: ...`                                                          | A fan-out job is never re-planned: start a new run          |
| `Approval gate "<job>[approve-canary]" of fan-out job "<job>" was rejected; neither a retry nor --from asks it again.`   | Start a new run                                             |

### Reading a fan-out run

`swamp workflow history get <workflow-or-run> [--server <url>]` rebuilds every
fan-out job from the run record, including runs serve continued after an
approval. Log mode prints a **Fan-out** block under the job: selector and
policy, batches, budget, one line per member, halts, gates and the latest
resume. With `--json`, each fan-out job carries a `fanOut` object:

| Field          | Holds                                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `selector`     | `labels` / `platform` as authored                                                                                                                 |
| `policy`       | `offline`, `minWorkers`; absent when the run's evaluated workflow is gone                                                                         |
| `plannedLanes` | lanes the plan made                                                                                                                               |
| `batches`      | worker names per batch                                                                                                                            |
| `budget`       | `allowed` (null = no budget) and `used` (lanes failing now)                                                                                       |
| `members[]`    | `worker`, `disposition` (`dispatch`, `waiting`, `skipped`, `failed`, `excluded`), `reason`, `batch`, `lane`                                       |
|                | `lane`: `succeeded`, `failed`, `held`, `running`, `unknown`, `not_run`; plus `failedSteps`, `assertions`                                          |
| `halts[]`      | `reason: budget` with `batch` (index), `maxFailures`, `failed`, `held`; or `reason: gate_rejected`, `gate`, `held`                                |
| `gates[]`      | `kind`, `step`, `status` (`pending`, `waiting`, `expired`, `approved`, `rejected`, `held`, `failed`), `expiredAt`, `approval` (who, when, reason) |
| `resume`       | latest resume only: `at`, `rerun`, `kept` lanes; earlier resumes are not recorded                                                                 |

A job without `fanOut` has no `fanOut` key. Members carry worker names only,
never instance ids.

## Affinity (worker co-location)

Add `affinity: true` at the **workflow** or **job** level to pin all remote
steps in that scope to the same worker. The first step dispatched via normal
label/platform matching picks the worker; every subsequent step in the group is
bound to that worker. The pin does not replace a step's own placement: a later
step whose `target`, `labels` or `platform` the pinned worker does not meet
fails with an `AffinityPlacementMismatchError` and is never sent elsewhere. As
in scheduling, a step's `target` stands in for its labels and platform.

```yaml
jobs:
  - name: build-and-test
    affinity: true
    labels: { gpu: "true" }
    steps:
      - name: checkout
        task: ...
      - name: build
        task: ...
```

Workflow-level affinity scopes the pin to the entire run; job-level scopes it to
the job. A job sets `affinity: false` to opt out of workflow-level affinity —
its steps are placed independently — while a job's `affinity: true` under
workflow-level affinity keeps the run-wide pin. If the pinned worker disconnects
or starts draining mid-group, steps fail with a `WorkerAffinityLostError` rather
than silently re-dispatching — the co-location contract is preserved. The pin
binds when the first step completes; before that, a first step that loses its
worker without writing re-dispatches. A first step that fails for another reason
(a method error, refused arguments) still binds the group to its worker, so the
rest of the group runs there; only a lost worker fails the other steps.
Validation warns when `affinity: true` is set without any placement fields (a
no-op), and when placed steps in one affinity group declare different placement,
since which step dispatches first (and so picks the worker) varies between runs.

## Remote-only mode

By default, steps without placement run locally on the orchestrator. Enable
**remote-only mode** to forbid local execution entirely — every user step must
declare placement and be dispatched to a worker. Steps that lack a `target`,
`labels`, or `platform` block fail immediately instead of falling back to
in-process execution.

Enable via any of:

| Mechanism           | Value                    |
| ------------------- | ------------------------ |
| CLI flag            | `--remote-only`          |
| Serve config (YAML) | `remote-only: true`      |
| Environment var     | `SWAMP_REMOTE_ONLY=true` |

When an unplaced step runs in remote-only mode, swamp raises a `UserError`:

```
Step 'train' on model '@acme/ml-pipeline' has no placement but the server is
running in remote-only mode. Add a placement block (target, labels, or platform)
to the workflow step, job, or workflow so it can be dispatched to a remote worker.
```

The fix is a workflow-level or job-level placement default so all steps inherit
it:

```yaml
name: deploy-pipeline
labels:
  pool: gke
jobs:
  - name: build
    steps:
      - name: compile
        task: ... # inherits workflow labels — dispatched to a worker
```

Built-in control-plane behaviors (`swamp/*` — server tokens, enrollment tokens,
workers, step leases) are exempt: they always run on the orchestrator regardless
of remote-only mode.

Placement moves **method bodies** only. The orchestrator still evaluates guards,
resolves data references, and performs all data I/O — workers hold no
credentials or repository state.

## Running workflows through the orchestrator

`swamp serve` is the orchestrator, so placed workflows must run through it. From
any machine (no local repo needed):

```bash
swamp workflow run my-workflow --server ws://orchestrator:4000 --input env=prod
swamp behavior run my-model create --server ws://orchestrator:4000
```

Events stream back live through the same renderers as a local run; Ctrl-C
cancels the run on the server. `http://` URLs are accepted and upgraded. Flags
the serve protocol does not carry (`--skip-checks`, report filters, direct
`@type` execution for method runs) are rejected with a clear error. There is no
authentication yet — same trust model as `swamp serve` itself.

## Semantics worth knowing

- Placement requires running under `swamp serve` (the orchestrator); a placed
  step outside it fails with a clear error.
- All data reads/writes, vault secrets, and definition loads proxy to the
  orchestrator — workers hold no credentials or repository. Writes land at the
  orchestrator immediately and survive a worker crash; a step that wrote and
  then lost its worker fails the run (no-write steps re-dispatch automatically).
- Steps that mutate external systems (API calls, `kubectl apply`, SSH) without
  calling `writeResource` should declare `writes: true` to prevent re-dispatch
  on worker disconnect. Without the declaration, the orchestrator classifies the
  step as no-write (based on runtime data-plane inference) and re-dispatches it,
  potentially double-executing non-idempotent side effects.
- The orchestrator ships its environment variables with each dispatch
  (process-identity vars like HOME/PATH excluded), so ambient credentials work
  remotely as they do locally.
- Worker pool state is queryable swamp data:
  `swamp data query
  'modelType == "swamp/worker"'`.
