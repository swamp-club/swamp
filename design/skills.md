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
2. **Test** — validate quality (tessl) and trigger routing (promptfoo)
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
└── evals/                # Optional — trigger evaluation test cases
    └── trigger_evals.json
```

### SKILL.md

**Frontmatter** (required YAML between `---` fences):

- `name` — hyphen-case identifier, must match directory name, max 64 chars
- `description` — what the skill does AND when to trigger it. This is the
  primary mechanism Claude uses to decide whether to load the skill, so include
  specific trigger phrases and contexts. Max 1024 chars.

No other frontmatter fields (except optional `license`).

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
    "note": "Listing stored data routes to swamp-data, not this skill"
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

## Testing Locally

Both testing tools require **Node.js/npm** and **Deno** installed locally. They
test fundamentally different things:

- **Tessl** answers: _"Is this skill well-written?"_ — it scores the quality of
  the SKILL.md description and content.
- **Promptfoo** answers: _"Does the LLM actually route to this skill
  correctly?"_ — it sends real queries to a model and checks which skill gets
  called.

A skill can score perfectly on tessl but still fail promptfoo if its description
overlaps with another skill. Both must pass.

### Tessl — Skill Quality Review

Tessl evaluates the structural quality of a skill's SKILL.md by scoring its
description and content.

**Review a single skill:**

```bash
npx tessl skill review .claude/skills/<skill-name> --json
```

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

### Promptfoo — Trigger Routing Evaluation

Promptfoo tests whether an LLM correctly routes user queries to the right skill.
It reads all `trigger_evals.json` files, presents each query to the model as a
tool-selection task, and asserts that the correct skill was (or was not) called.

**Run against the default model (sonnet):**

```bash
export ANTHROPIC_API_KEY=<your-key>
deno run eval-skill-triggers
```

**Run against a specific model:**

```bash
export ANTHROPIC_API_KEY=<your-key>
deno run eval-skill-triggers --model opus

export OPENAI_API_KEY=<your-key>
deno run eval-skill-triggers --model gpt-4.1

export GOOGLE_API_KEY=<your-key>
deno run eval-skill-triggers --model gemini-2.5-pro
```

**Tune concurrency and threshold:**

```bash
deno run eval-skill-triggers --model sonnet --concurrency 10 --threshold 0.85
```

Defaults are concurrency 20 and threshold 90%. Each sonnet run costs ~$2 and
takes ~30 seconds.

If the required API key is missing, the script gracefully skips (exits 0) rather
than failing.

## CI Pipeline

CI runs skill checks automatically when relevant files change. The change
detection filter triggers on modifications to:

- `.claude/skills/**`
- `CLAUDE.md`
- `scripts/review_skills.ts`
- `evals/promptfoo/**`

### PR Checks

Two jobs run in parallel on every PR that touches skill files:

**skill-review** — runs `deno run review-skills` (tessl) against all skills.
Fails the PR if any skill scores below 90%.

**skill-trigger-eval** — runs `deno run eval-skill-triggers` (promptfoo) with
the default sonnet model. Fails the PR if the pass rate drops below 90%.

Both jobs write detailed results to the GitHub Actions step summary for easy
review.

### Weekly Multi-Model Regression

A scheduled workflow (`multi-model-eval.yml`) runs every Saturday at 08:00 UTC.
It tests trigger routing against four models in parallel:

| Model          | Provider  | Concurrency | API Key Env        |
| -------------- | --------- | ----------- | ------------------ |
| sonnet         | Anthropic | 20          | `ANTHROPIC_API_KEY` |
| opus           | Anthropic | 20          | `ANTHROPIC_API_KEY` |
| gpt-4.1        | OpenAI    | 5           | `OPENAI_API_KEY`   |
| gemini-2.5-pro | Google    | 20          | `GOOGLE_API_KEY`   |

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
                     │  promptfoo → routing ok?│
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
