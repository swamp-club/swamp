# Remote Execution: Workers and Step Placement

Remote execution fans workflow steps out across **workers** — disposable swamp
processes that dial home to an orchestrator (`swamp serve`), enroll with a
token, and execute dispatched method bodies with every capability proxied back
to the orchestrator. It replaces the removed execution-driver abstraction
(`driver:`/`driverConfig:` fields no longer exist); for isolation, run a
containerized worker and select it with labels. Full design:
`design/remote-execution.md`.

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
disconnects the worker and rejects re-enrollment. Pass a stable `--cache-dir` to
keep the machine identity across restarts — the default temp cache directory
yields a fresh identity (and thus needs a fresh token) per process. Manage
tokens with `swamp worker token list` and `swamp worker token revoke <name>`;
inspect the pool with `swamp worker list`.

## Placing steps on workers

A step declaring any placement field dispatches to a matching worker instead of
running in-process; steps without placement are unaffected:

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
all-busy queues the step, and no eligible worker fails the step fast. `forEach`
is the fan-out construct — expand a step over a list and the instances spread
across matching workers (each worker runs one dispatch at a time).

## Running workflows through the orchestrator

`swamp serve` is the orchestrator, so placed workflows must run through it. From
any machine (no local repo needed):

```bash
swamp workflow run my-workflow --server ws://orchestrator:4000 --input env=prod
swamp model my-model method run create --server ws://orchestrator:4000
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
  orchestrator — workers hold no credentials or repository. Writes are durable
  at the orchestrator immediately; a step that wrote and then lost its worker
  fails the run (no-write steps re-dispatch automatically).
- The orchestrator ships its environment variables with each dispatch
  (process-identity vars like HOME/PATH excluded), so ambient credentials work
  remotely as they do locally.
- Worker pool state is queryable swamp data:
  `swamp data query
  'modelType == "swamp/worker"'`.
