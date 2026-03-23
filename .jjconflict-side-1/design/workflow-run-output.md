# Workflow Run Output: Progressive Tree

## Problem

Swamp's `workflow run` supports two output modes: `log` (streaming scoped log
lines) and `json` (single JSON blob at end). Neither serves the human terminal
experience well.

`log` mode prints every event as a flat log line with category prefixes
(`workflow·run·deploy·job-1·step-2 Step started`). Reports render inline as they
complete, interleaved with progress noise. There is no visual separation between
"the work happening" and "the results I care about."

`json` mode is silent until the end — correct for machine consumption, hostile to
humans.

The core tension: **during execution, users want reassurance that progress is
happening; after execution, they want clean, scannable results.** These are two
fundamentally different attention states, and the current log mode conflates
them.

## Design Principles

This design draws on Jef Raskin's _The Humane Interface_ and empathy-driven
design:

- **Shifting locus of attention** — progress is peripheral (glanceable);
  results are focal (readable). The interface should match the user's attention
  state at each phase.
- **Habituation** — users learn quickly that the bottom of the terminal shows
  current state and the end of output has the reports. No mode-switching, no key
  presses.
- **Visibility of system state** — the user can see the workflow structure from
  the start: what's running, what's waiting, what's blocked.
- **Progressive reveal** — the tree fills in as work completes, building a
  chronological narrative in the scroll buffer.

## Architecture: Two Zones

The output is divided into two zones:

- **Scrollback zone** — permanent lines that scroll up into the terminal buffer.
  Contains completed job branches, output blocks, rendered reports, and errors.
- **Active zone** — the bottom of the terminal, redrawn in-place on each event.
  Contains currently-running jobs, their active steps, output peek windows, and
  waiting/blocked jobs.

The active zone shrinks as jobs complete and their lines graduate to scrollback.
After the workflow finishes, the active zone is empty and only scrollback
remains — the user can scroll up to see the full history.

```
┌─────────────────────────────────────────────────────────────────┐
│ deploy                                                          │
│   ├─ provision                 ✓ ec2-instance → create (3.2s)   │ scrollback
│   │ Creating EC2 instance i-abc123...                           │ (permanent)
│   │ Instance running.                                           │
│   ── @swamp/method-summary (ec2-instance/create) ────────────   │
│     ...                                                         │
│   ──────────────────────────────────────────────────────────── │
├─────────────────────────────────────────────────────────────────┤
│   ├─ configure                 ⠋ nginx-config → validate        │ active zone
│   │  │ checking port 443...                                     │ (in-place)
│   └─ security                  ○ blocked                        │
└─────────────────────────────────────────────────────────────────┘
```

There is no visible border between the zones — this diagram is for illustration.

## Job Lines

Each job gets **one line** as its permanent scrollback entry. During execution,
the job line lives in the active zone and updates in-place to reflect the
current step. When the job completes, the line prints to scrollback with the
final state.

### Sequential steps

When a job's steps run sequentially, the job line shows the currently-active
step:

```
  ├─ provision                 ⠋ ec2-instance → create
```

When the job completes, the scrollback line reflects the outcome:

- **1 step**: shows the step name —
  `✓ ec2-instance → create (3.2s)`
- **N steps**: summarizes —
  `✓ 3 steps (4.1s)`

### Parallel steps (expansion)

When a job has multiple steps running concurrently, it temporarily **expands**
in the active zone to one line per active step:

```
  ├─ configure                 ⠋ 3 running
  │  ├─ nginx-config → validate        ⠋ 1.2s
  │  ├─ app-config → validate          ⠋ 0.8s
  │  └─ ssl-cert → validate            ⠋ 0.3s
```

As each step completes, the sub-lines collapse. When the last step finishes,
the job collapses back to one line and scrolls up:

```
  ├─ configure                 ✓ 3 steps (4.1s)
```

## Output Buffering and Peek

Each step maintains an **output buffer** of its stdout/stderr lines. The active
zone can show a live peek of the tail of this buffer under the step, if terminal
budget allows. When the step completes, the full buffer flushes to scrollback.

### Live peek (active zone)

When only one step is running and there is space, the active zone shows the
last few lines of output below the step:

```
  ├─ provision                 ⠋ ec2-instance → create (1.4s)
  │  │ Creating EC2 instance i-abc123...
  │  │ Waiting for instance to reach running state...

  ├─ configure                 ○ waiting
  └─ security                  ○ blocked
```

As new output arrives, the peek window scrolls — older lines are replaced by
newer ones:

```
  ├─ provision                 ⠋ ec2-instance → create (2.1s)
  │  │ Waiting for instance to reach running state...
  │  │ Instance running.

  ├─ configure                 ○ waiting
  └─ security                  ○ blocked
```

For parallel steps, the available peek lines are distributed across active
steps. Each step may get 1 line, or none if the budget is tight:

```
  ├─ configure                 ⠋ 3 running
  │  ├─ nginx-config → validate        ⠋ 1.2s
  │  │  │ checking port 443...
  │  ├─ app-config → validate          ⠋ 0.8s
  │  │  │ loading defaults...
  │  └─ ssl-cert → validate            ⠋ 0.3s
  │     │ fetching certificate...
  └─ security                  ○ blocked
```

### Full buffer flush (scrollback)

When a step completes, the full output buffer prints to scrollback. For jobs
with multiple steps, output is grouped by step:

```
  ├─ configure                 ✓ 3 steps (4.1s)
  │ [nginx-config → validate]
  │ checking port 443...
  │ port 443 ok
  │ [app-config → validate]
  │ loading defaults...
  │ defaults applied
  │ [ssl-cert → validate]
  │ fetching certificate...
  │ certificate valid
```

This means the user sees output twice — a live peek during execution, and the
complete record in scrollback — but neither is wasted. The peek serves
peripheral attention ("what's happening now?"), and the scrollback serves the
permanent record.

## Reports

### Method-scope reports

Method-scope reports run immediately after their step completes. They flush to
scrollback right after the step's output block:

```
  ├─ provision                 ✓ ec2-instance → create (3.2s)
  │ Creating EC2 instance i-abc123...
  │ Waiting for instance to reach running state...
  │ Instance running.
  ── @swamp/method-summary (ec2-instance/create) ────────────────
    [rendered markdown]
  ───────────────────────────────────────────────────────────────
```

### Workflow-scope reports

Workflow-scope reports run after all jobs complete. They print to scrollback at
the very end, followed by data artifact hints:

```
  └─ security                  ✓ firewall-rules → create (5.1s)
  │ Applying rule: allow-https-ingress
  │ Applying rule: deny-all-other

  ── @swamp/workflow-summary ────────────────────────────────────
    [rendered markdown]
  ───────────────────────────────────────────────────────────────

  View produced data:
    swamp data list --workflow deploy
    swamp data get --workflow deploy ec2-state
```

### Report progress in the active zone

While reports are running, the active zone shows a progress line:

```
  ⠋ Running reports (1/3)...
```

Each report scrolls up as rendered markdown when it completes. The progress line
updates until all reports are done.

## Terminal Budget and Graceful Degradation

The active zone must fit within the terminal height. When it cannot, it degrades
through tiers.

### Budget calculation

Measure terminal height. Subtract lines for the workflow header and breathing
room. The remainder is the budget for the active zone. Recalculate on every
redraw and on `SIGWINCH` (terminal resize).

### Tier system

| Tier | When | Active zone shows |
| ---- | ---- | ---- |
| Full | Everything fits | Expanded steps + peek lines + waiting jobs |
| No peek | Steps fit but not with peek lines | Expanded steps + waiting jobs |
| Compressed waiting | Steps don't fit with waiting jobs | Expanded steps + `… N jobs waiting` |
| Compressed steps | Expanded steps alone don't fit | One line per job (count) + `… N jobs waiting` |

**Full** — expanded parallel steps, peek lines showing output buffer tails, all
waiting/blocked jobs listed:

```
  ├─ configure                 ⠋ 3 running
  │  ├─ nginx-config → validate        ⠋ 1.2s
  │  │  │ checking port 443...
  │  ├─ app-config → validate          ⠋ 0.8s
  │  │  │ loading defaults...
  │  └─ ssl-cert → validate            ⠋ 0.3s
  │     │ fetching certificate...
  ├─ monitoring                ⠋ cloudwatch → setup
  ├─ security                  ○ blocked
  ├─ cleanup                   ○ blocked
  └─ notify                    ○ blocked
```

**No peek** — expanded steps but no output preview:

```
  ├─ configure                 ⠋ 3 running
  │  ├─ nginx-config → validate        ⠋ 1.2s
  │  ├─ app-config → validate          ⠋ 0.8s
  │  └─ ssl-cert → validate            ⠋ 0.3s
  ├─ monitoring                ⠋ cloudwatch → setup
  ├─ security                  ○ blocked
  ├─ cleanup                   ○ blocked
  └─ notify                    ○ blocked
```

**Compressed waiting** — expanded steps, waiting jobs collapsed to a count:

```
  ├─ configure                 ⠋ 3 running
  │  ├─ nginx-config → validate        ⠋ 1.2s
  │  ├─ app-config → validate          ⠋ 0.8s
  │  └─ ssl-cert → validate            ⠋ 0.3s
  ├─ monitoring                ⠋ cloudwatch → setup
  … 3 jobs waiting
```

**Compressed steps** — one line per running job, no expansion:

```
  ├─ configure                 ⠋ 3/5 steps (1.2s)
  ├─ monitoring                ⠋ 4/4 steps (0.8s)
  ├─ ingestion                 ⠋ 2/6 steps (3.1s)
  ├─ validation                ⠋ 8/12 steps (0.5s)
  … 6 jobs waiting
```

**One line** - in the extreme case, render as a single line for the workflow.

## Errors

Failed steps surface immediately. The error line prints to scrollback along
with the job line — it does not wait for the job to complete:

```
  ├─ configure                 ✗ nginx-config → validate (2.8s)
  │  Error: schema validation failed for port field
```

If other steps in the job continue (allowed failure, or parallel steps still
running), the job stays in the active zone. The error is already in scrollback.

## Full Example: End-to-End

A workflow `deploy` with three sequential jobs: `provision` (1 step),
`configure` (2 steps), and `security` (1 step).

### T=0 — Workflow starts

Active zone shows the full tree skeleton:

```
deploy
  ├─ provision                 ⠋ ec2-instance → create
  ├─ configure                 ○ waiting
  └─ security                  ○ blocked
```

### T=1.4s — Step output arrives

Peek window shows the tail of the output buffer:

```
deploy
  ├─ provision                 ⠋ ec2-instance → create (1.4s)
  │  │ Creating EC2 instance i-abc123...
  │  │ Waiting for instance to reach running state...
  ├─ configure                 ○ waiting
  └─ security                  ○ blocked
```

### T=3.2s — Provision completes

Job line + full output buffer + method report flush to scrollback. Active zone
redraws without it:

```
deploy                                                        ← scrollback
  ├─ provision                 ✓ ec2-instance → create (3.2s)
  │ Creating EC2 instance i-abc123...
  │ Waiting for instance to reach running state...
  │ Instance running.
  ── @swamp/method-summary (ec2-instance/create) ───────────
    ...
  ──────────────────────────────────────────────────────────

  ├─ configure                 ⠋ nginx-config → validate      ← active zone
  └─ security                  ○ blocked
```

### T=5.8s — First configure step completes, second starts

```
  ├─ configure                 ⠋ app-config → validate (step 2/2)
  └─ security                  ○ blocked
```

### T=7.3s — Configure completes

Job line + output flush to scrollback:

```
  ├─ configure                 ✓ 2 steps (4.1s)               ← scrollback
  │ [nginx-config → validate]
  │ checking port 443...
  │ port 443 ok
  │ [app-config → validate]
  │ loading defaults...
  │ defaults applied

  └─ security                  ⠋ firewall-rules → create      ← active zone
```

### T=12.4s — Security completes, all jobs done

Last job flushes to scrollback. Reports run and print:

```
deploy
  ├─ provision                 ✓ ec2-instance → create (3.2s)
  │ Creating EC2 instance i-abc123...
  │ Waiting for instance to reach running state...
  │ Instance running.
  ── @swamp/method-summary (ec2-instance/create) ───────────
    ...
  ──────────────────────────────────────────────────────────
  ├─ configure                 ✓ 2 steps (4.1s)
  │ [nginx-config → validate]
  │ checking port 443...
  │ port 443 ok
  │ [app-config → validate]
  │ loading defaults...
  │ defaults applied
  └─ security                  ✓ firewall-rules → create (5.1s)
  │ Applying rule: allow-https-ingress
  │ Applying rule: deny-all-other

  ── @swamp/workflow-summary ────────────────────────────────
    [rendered markdown]
  ───────────────────────────────────────────────────────────

  View produced data:
    swamp data list --workflow deploy
    swamp data get --workflow deploy ec2-state
```

The user can scroll up to see the full history — tree structure, output,
reports — all in the terminal buffer.

## Non-TTY Fallback

When stdout is not a TTY (CI, piped output), fall back to log mode.

## Relationship to Existing Output Modes

This design introduces a third output mode alongside the existing `log` and
`json` modes:

| Mode | Audience | Behavior |
| ---- | ---- | ---- |
| `log` | Developers, debugging | Flat scoped log lines via LogTape, all events |
| `json` | Machines, scripts | Silent until end, single JSON blob |
| Progressive tree | Human terminal users | Two-zone tree with output buffering and reports |

The progressive tree mode becomes the default for TTY terminals. The existing
`log` and `json` modes remain available via flags. The renderer pattern
(see `design/rendering.md`) supports this naturally — adding the new mode is a
matter of implementing a new renderer, with no changes to libswamp or command
handlers.

## Implementation Notes

### Cursor manipulation

The active zone uses ANSI escape sequences to move the cursor up and clear
lines. On each redraw: move cursor up by the number of active zone lines,
clear from cursor to end of screen, and print the new active zone. This is the
same technique used by tools like Docker Compose and npm progress bars.

### Event stream

No changes to `WorkflowRunEvent` are required. The existing event stream
provides all the information needed — job/step lifecycle events, method output,
report results, and the final completed view. The new renderer consumes the
same stream as the existing log and JSON renderers.

### Workflow structure

The workflow DAG is known after the `evaluating_workflow` / `started` events.
The renderer can compute tree prefixes (├─, │, └─) and job positions upfront,
enabling structurally-correct tree lines from the first event.

### Output buffer memory

Output buffers are per-step and hold all stdout/stderr lines until the step
completes. For steps that produce very large output, a cap (e.g., last 1000
lines) prevents unbounded memory growth. The peek window in the active zone
always shows only the last N lines regardless.
