---
audience: maintainer
last-verified: 2026-08-28 @ 3d5955a9
---

# Skill Lifecycle

This document describes how skills are authored, tested, and shipped through CI.

## Overview

A skill gives Claude specialized knowledge about a specific domain. At runtime,
skills work through progressive disclosure:

- Claude always sees every skill's `name` and `description` in the system prompt
- When a user query matches a skill's description, Claude loads the full
  `SKILL.md` body into context
- If the skill references detailed docs in `references/`, Claude loads those on
  demand as needed

This means the `description` field is the single most important part of a
skill — it's the trigger mechanism that decides whether Claude engages the skill
at all.

Skills live in `.claude/skills/<skill-name>/` and follow a three-phase lifecycle:

1. **Author** — create the skill following skill-creator conventions
2. **Test** — validate quality (tessl) and trigger routing (`swamp-eval`)
3. **Ship** — CI gates enforce quality before merge

Authoring and testing are iterative — after using a skill on real tasks, you
refine the description, body, or evals based on what worked and what didn't.

## Authoring a Skill

Always load the `skill-creator` skill before creating or modifying a skill — it
is the authoritative guide for structure and best practices.

### Directory Structure

```
.claude/skills/<skill-name>/
├── SKILL.md              # Required — uppercase, contains frontmatter + body
├── references/           # Optional — detailed docs loaded on demand
│   └── *.md
└── evals/                # Optional — evaluation test cases
    ├── trigger_evals.json           # Phase 1 — does this skill trigger?
    ├── routing_evals.json           # Phase 2 — which guide does it load?
    └── guide_sufficiency_evals.json # Phase 3 — is the guide enough?
```

Only gateway skills with a `references/<topic>/guide.md` tree (currently
`swamp`) need the phase 2 and phase 3 files.

### SKILL.md

**Frontmatter** (required YAML between `---` fences):

- `name` — hyphen-case identifier, must match directory name, max 64 chars
- `description` — what the skill does AND when to trigger it. This is the
  primary mechanism Claude uses to decide whether to load the skill, so include
  specific trigger phrases and contexts. Max 1024 chars.

No other frontmatter fields (except optional `license`). The bundled `swamp` and
`swamp-getting-started` skills also carry a fixed `metadata` block, explained in
`design/surfaces/agent-interface.md`; keep it.

**Body** guidelines:

- Keep under 500 lines — split detailed content into `references/` files
- Use imperative form ("Use this for…", "To create…")
- Do not duplicate "when to use" guidance that belongs in the description
- Run `deno fmt` after editing

### Progressive Disclosure

Skills load in three tiers to manage context efficiently:

1. **Metadata** (name + description) — always in context (~100 words)
2. **SKILL.md body** — loaded when the skill triggers (<5k words)
3. **References** — loaded on demand by Claude as needed (unlimited)

Keep only core workflow and selection guidance in SKILL.md. Move variant-specific
details, API references, and lengthy examples into `references/`.

## Writing Trigger Evals

Trigger evals define test cases that verify Claude routes user queries to the
correct skill. They live at
`.claude/skills/<skill-name>/evals/trigger_evals.json`.

### Format

```json
[
  {
    "query": "Search for model types that handle payments",
    "should_trigger": true,
    "note": "type search is a listed trigger keyword"
  },
  {
    "query": "List all the data I have stored",
    "should_trigger": false,
    "note": "Listing stored data routes to the swamp skill (data guide), not this skill"
  }
]
```

Each entry has:

- `query` — a realistic user request
- `should_trigger` — `true` if this query should route to this skill, `false` if
  it should route elsewhere
- `note` — optional explanation of the routing decision

Write both positive and negative cases. Negative cases are important — they
verify that similar-sounding queries route to the correct neighboring skill
rather than this one.

## Writing Routing Evals

Routing evals check the _second_ hop: once the gateway skill has triggered, does
Claude load the right guide from the SKILL.md routing table? They live at
`.claude/skills/<skill-name>/evals/routing_evals.json`.

### Format

```json
[
  {
    "query": "Show me the run history for the deployment workflow",
    "expected_guide": "workflow"
  }
]
```

Each entry has:

- `query` — a realistic user request that has already reached this skill
- `expected_guide` — the directory name under `references/` whose `guide.md`
  should be loaded

Every guide topic must have at least one case. `skill_routing_test.ts` derives
the topic list from the `references/` directory on disk, so adding a new guide
without adding routing evals fails the unit test — no model run needed.

## Writing Sufficiency Evals

Sufficiency evals check the _third_ hop: given only the short `guide.md`, can
Claude answer the query, or must it descend into `reference.md`? They live at
`.claude/skills/<skill-name>/evals/guide_sufficiency_evals.json`.

### Format

```json
[
  {
    "query": "Search for model types that handle payments",
    "guide": "model",
    "answerable_from_guide": true,
    "note": "Quick Reference table has the search command"
  }
]
```

Each entry has:

- `query` — a realistic user request
- `guide` — the topic whose `guide.md` is supplied as the only context
- `answerable_from_guide` — `true` if the guide alone suffices, `false` if the
  detail lives in `reference.md` or a deeper `references/` file
- `note` — where the answer lives, which makes failures diagnosable

Balance the two outcomes per topic: `true` cases catch guides that have gone too
thin, `false` cases catch guides that have absorbed reference material they
should have delegated. Self-contained guides with no `reference.md` carry only
`true` cases.

## Testing Locally

Tessl needs **Node.js/npm**; the routing evals need **Go** (the version pinned
in `.tool-versions`). They test fundamentally different things:

- **Tessl** answers: _"Is this skill well-written?"_ — it scores the quality of
  the SKILL.md description and content.
- **`swamp-eval`** answers: _"Does the LLM actually route to this skill
  correctly?"_ — it sends real queries to a model and checks which skill gets
  called.

A skill can score perfectly on tessl but still fail the routing evals if its description
overlaps with another skill. Both must pass.

### Tessl — Skill Quality Review

Tessl evaluates the structural quality of a skill's SKILL.md by scoring its
description and content.

**Review a single skill:**

```bash
npx tessl review run .claude/skills/<skill-name> --json --workspace swamp-club
```

It authenticates with `TESSL_TOKEN` (or an interactive `tessl login`).

This returns three metrics:

- **Validation** — structural checks (frontmatter format, naming conventions)
- **Description Judge** — quality score for the frontmatter description (0–1.0)
- **Content Judge** — quality score for the SKILL.md body (0–1.0)

The average of description and content scores must be ≥ 90%.

**Review all skills at once:**

```bash
deno run review-skills
```

This runs tessl against every skill in `.claude/skills/` and prints a summary
table. In CI, it writes the table to the GitHub Actions step summary.

### `swamp-eval` — Routing Evaluation

`swamp-eval` (a standard-library-only Go module in `tools/swamp-eval`) tests
whether an LLM actually navigates from a user query to the right context.
`deno run eval-skill-triggers` runs the evaluator's unit tests, then all three
suites against the same model, and reports a combined pass rate:

| Suite       | Eval file                      | Question                                          |
| ----------- | ------------------------------ | ------------------------------------------------- |
| trigger     | `trigger_evals.json`           | Does the right skill trigger?                     |
| routing     | `routing_evals.json`           | Does the right guide get loaded?                  |
| sufficiency | `guide_sufficiency_evals.json` | Is the guide enough, or is `reference.md` needed? |

Every choice is offered to the model as a tool, and a case passes when the
model calls exactly the expected one. In the trigger suite the skills are offered
as `skill_a` and `skill_b`, never by name: nearly every positive query mentions
swamp, so a tool named `swamp` would pass with any description. Reports map the
picks back to skill names. A `should_trigger: false` trigger case
passes on any choice other than its own skill, so a query that belongs to the
other bundled skill is not a failure. A provider error, a timeout, or an answer
outside the offered set counts against the pass rate and is reported separately
as an error, so an outage never reads as a pass or as a prompt regression.

Each run writes one JSON artifact, `eval-results/<model>.json` (gitignored),
with every case's expected and actual tool, error category, latency and tokens.
A run that stops before any case (a bad key, no credits, a logged-out CLI) still
writes one, marked `failed` with the reason, so the cross-model report names the
cause. Cost estimates price prompt-cache reads at the provider's cache rate.
`go -C tools/swamp-eval run ./cmd/swamp-eval cases --full` prints the exact
prompts and tools each case sends, without calling a model.

The routing catalog (`tools/swamp-eval/internal/cases/routing.go`) must list
every directory under `references/`; the evaluator's tests fail on a guide it
does not offer, and a fixture naming an unknown guide fails the run before any
model call.

**Routes.** Anthropic models (`opus`, `sonnet`) run locally through the Claude
Code CLI: `claude -p` with no tools, every choice's name and description in the
system prompt, and a JSON-schema enum of the names that forces one pick. A
claude.ai login is enough and no `ANTHROPIC_API_KEY` is read. `--route cli|api`
overrides the default, which is `api` in GitHub Actions and for models with no
CLI route (`fable`, `gpt-5.4`, Gemini), and `cli` otherwise. The optional
`gpt-6-astra` model always uses the Codex CLI route, including in Actions.
A preflight sends one tiny case through the real adapter; an unusable CLI or
key fails the run (exit 2), it never skips.

The Claude CLI route passes a model alias, so it follows the latest model, and
records the exact model each run resolved to in the artifact and summary. It has
no temperature or forced tool choice; the schema enum forces the pick and
`--effort` (low for sonnet, medium for opus) stands in for thinking.

**Run against the default model (opus):**

```bash
deno run eval-skill-triggers --model opus
```

**Run against a specific model or suite:**

```bash
deno run eval-skill-triggers --model sonnet --suite routing

# Optional Codex CLI, using an existing Codex login
deno run eval-skill-triggers --model gpt-6-astra --route cli

# API route, as CI runs it
export ANTHROPIC_API_KEY=<your-key>
deno run eval-skill-triggers --model sonnet --route api

export OPENAI_API_KEY=<your-key>
deno run eval-skill-triggers --model gpt-5.4

export GOOGLE_API_KEY=<your-key>
deno run eval-skill-triggers --model gemini-2.5-pro
```

**Tune concurrency and threshold:**

```bash
deno run eval-skill-triggers --model sonnet --concurrency 10 --threshold 0.85
```

`go -C tools/swamp-eval run ./cmd/swamp-eval list-models` prints every alias,
its routes, key variable, concurrency and pricing. Other flags: `--suite`,
`--timeout` (per case, default 120s), `--out`, `--github-summary`. There are no
retries: a failed call is an error case.

**Building the evaluator.** Every run, local or verification or CI, builds
through `tools/swamp-eval/build.sh` (`deno task build-eval-tool`): it compiles
with exactly the Go pinned in `.tool-versions` (Go downloads and
checksum-verifies that toolchain if yours differs), checks `gofmt`, runs
`go vet` and the unit tests, none of which call a model, and writes
`.bin/swamp-eval` (gitignored). The build is reproducible and stamped with the
source tree id, and every run prints that stamp, the Go version and, on the CLI
route, the `claude`/`codex` version, all recorded in the artifact. Builds after
the first take about a tenth of a second from Go's cache. To see exactly what a
case sends, use `./.bin/swamp-eval cases --full`. Upgrading Go is one line in
`.tool-versions`; upgrading the evaluator is merging to `main`.

`verify-skills` accepts `--input reviewer=codex` to select this Codex model
for all three suites. Omit the input to keep Claude (`opus`). Tessl skill
quality review is independent of this selection.

Defaults are concurrency 6 on the CLI route (every case is a separate CLI
process on your subscription) and 20 on the API route (1 for `gpt-5.4`), and
threshold 90%. An API-route sonnet run costs ~$2; the CLI route is billed to the
subscription and records tokens with a null dollar cost.

On the API route a missing provider key is an error (exit 2), so a green run
always means the evals ran. Exit 1 means the cases ran and missed the threshold.

## CI Pipeline

CI runs skill checks automatically when relevant files change. The change
detection filter triggers on modifications to:

- `.claude/skills/**`
- `CLAUDE.md`
- `scripts/review_skills.ts`
- `tools/swamp-eval/**`

### PR Checks

Two jobs run in parallel on every PR that touches skill files:

**skill-review** — runs `scripts/review_skills.ts` directly (the same script
behind `deno run review-skills`) with `TESSL_TOKEN` from repository secrets.
Fails the PR if any skill scores below 90%.

**skill-trigger-eval** — runs `deno run eval-skill-triggers` with the default
opus model, covering all three suites. Fails the PR if the combined
pass rate drops below 90%.

Both jobs write detailed results to the GitHub Actions step summary for easy
review.

### Weekly Multi-Model Regression

A scheduled workflow (`multi-model-eval.yml`) runs every Saturday at 08:00 UTC.
Each model job tests the evaluator, then runs
`swamp-eval run --model <m> --concurrency <n> --route api` — all three suites —
and uploads its `eval-results/<m>.json` artifact (retained 14 days). An analysis
job then runs `swamp-eval report` over every artifact, flags cases that fail on
more than one model, and reports a missing artifact as a failure:

| Model          | Provider  | Concurrency | API Key Env        |
| -------------- | --------- | ----------- | ------------------ |
| opus           | Anthropic | 20          | `ANTHROPIC_API_KEY` |
| sonnet         | Anthropic | 20          | `ANTHROPIC_API_KEY` |
| gpt-5.4        | OpenAI    | 1           | `OPENAI_API_KEY`   |
| gemini-2.5-pro | Google    | 20          | `GOOGLE_API_KEY`   |
| gemini-3.1-pro | Google    | 20          | `GOOGLE_API_KEY`   |
| fable          | Anthropic | 20          | `ANTHROPIC_API_KEY` |

This catches model-specific regressions that the single-model PR check would
miss. It can also be triggered manually via `workflow_dispatch` with a model
filter.

### After CI

Once all checks pass (skill review, trigger eval, code review, and standard
tests), PRs are auto-merged unless the `hold` label is applied.

## Lifecycle Flow

```
                        ┌─────────────────────┐
                        │       Author        │
                        │                     │
                        │  Create skill dir   │
                        │  Write SKILL.md     │
                        │  Write trigger evals│
                        │  Add references     │
                        └─────────┬───────────┘
                                  │
                                  ▼
                     ┌────────────────────────┐
                     │     Test Locally        │
                     │                         │
                     │  tessl  → quality ok?   │
                     │  evals  → routing ok?   │
                     └────────────┬────────────┘
                                  │
                          ┌───────┴───────┐
                          │ Pass?         │
                          │  no ──────────┼──── loop back to Author
                          │  yes          │
                          └───────┬───────┘
                                  │
                                  ▼
                     ┌────────────────────────┐
                     │      Open PR            │
                     │                         │
                     │  CI: skill-review       │
                     │  CI: skill-trigger-eval │
                     │  CI: code review        │
                     └────────────┬────────────┘
                                  │
                                  ▼
                     ┌────────────────────────┐
                     │      Merge              │
                     └────────────┬────────────┘
                                  │
                                  ▼
                     ┌────────────────────────┐
                     │  Use on real tasks      │
                     │                         │
                     │  Notice gaps or          │
                     │  mis-routes? Loop back   │
                     │  to Author.              │
                     └──────────────────────────┘

              Weekly: multi-model regression catches
              model-specific routing drift (Sat 08:00 UTC)
```
