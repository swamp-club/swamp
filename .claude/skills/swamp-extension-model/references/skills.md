# Bundling Skills with Extensions

Extensions can include **skills** — markdown guidance documents that teach
agents and humans how to use the extension's models effectively within a
specific organizational context.

Skills are passive — swamp never executes them. It registers metadata at install
time, surfaces descriptions for agent discovery, and serves content via the
tool's skill directory. The agent or human decides when to load and follow them.

## When to Bundle Skills

Bundle skills when your extension's models support workflows that benefit from
opinionated guidance. Common cases:

- **Workflow templates** — step-by-step processes built on top of generic models
  (e.g., a story creation template for a Redmine model)
- **Organizational conventions** — naming standards, approval checklists,
  security review steps
- **Domain-specific instructions** — how to use model methods in combination for
  a particular use case

A skills-only extension needs no TypeScript, no `deno.json`, no tests — just a
manifest and markdown files.

## Skill Directory Structure

Each skill is a directory containing a required `SKILL.md` and optional
supporting files:

```
.claude/skills/<skill-name>/
├── SKILL.md              # Required — uppercase
├── references/           # Optional — detailed docs loaded on demand
│   └── *.md
└── evals/                # Optional — trigger evaluation test cases
    └── trigger_evals.json
```

## SKILL.md Format

SKILL.md must have YAML frontmatter with `name` and `description`:

```markdown
---
name: create-story
description: >
  Use when creating a Redmine story issue with the @webframp/redmine model.
  Triggers on "create story", "new story", "story template".
---

# Create Story

Step-by-step instructions for creating a story...
```

**Frontmatter rules:**

| Field         | Required | Constraints                               |
| ------------- | -------- | ----------------------------------------- |
| `name`        | Yes      | Letters, numbers, hyphens only. Max 64 ch |
| `description` | Yes      | Max 1024 characters                       |

No other frontmatter fields are required (optional `license` is allowed).

**Body guidelines:**

- Keep under 500 lines — split detailed content into `references/` files
- Use imperative form ("Use this for…", "To create…")
- The `description` is the primary trigger mechanism — include what the skill
  does AND specific trigger phrases/contexts

## Progressive Disclosure

Skills load in three tiers to manage context efficiently:

1. **Metadata** (name + description) — always in context (~100 words)
2. **SKILL.md body** — loaded when the skill triggers (<5k words)
3. **References** — loaded on demand by the agent as needed (unlimited)

Keep only core workflow and selection guidance in SKILL.md. Move
variant-specific details, API references, and lengthy examples into
`references/`.

## Manifest Declaration

Declare skills in `manifest.yaml` as a flat list of directory names:

```yaml
manifestVersion: 1
name: "@myorg/redmine-workflow"
version: "2026.04.14.1"
description: "Workflow skills for @webframp/redmine"
skills:
  - create-story
  - create-task
  - hypothesis-task
dependencies:
  - "@webframp/redmine"
```

Each entry is a skill directory name resolved from:

1. **Project-local skill directory** — e.g., `.claude/skills/create-story/`
2. **Global skill directory** — e.g., `~/.claude/skills/create-story/`

The tool determines the skill directory path:

| Tool     | Skill Directory   |
| -------- | ----------------- |
| Claude   | `.claude/skills/` |
| Cursor   | `.cursor/skills/` |
| Opencode | `.agents/skills/` |
| Codex    | `.agents/skills/` |
| Kiro     | `.kiro/skills/`   |

## Validation Rules

During `swamp extension push`, skills are validated:

| Check                | Requirement                                    |
| -------------------- | ---------------------------------------------- |
| `SKILL.md` exists    | Each skill directory must contain a `SKILL.md` |
| Valid frontmatter    | YAML frontmatter with `name` and `description` |
| Individual file size | Max 500 KB per file                            |
| Total skill content  | Max 2 MB across all skills in the extension    |

Errors block the push. Warnings (e.g., presence of a `scripts/` directory) are
surfaced but don't block.

## Archive Structure

Skills are archived under `extension/skills/` in the tar.gz:

```
extension.tar.gz
└── extension/
    ├── manifest.yaml
    └── skills/
        ├── create-story/
        │   ├── SKILL.md
        │   └── references/
        │       └── templates.md
        └── create-task/
            └── SKILL.md
```

## Installation (Pull)

When a user runs `swamp extension pull @myorg/redmine-workflow`, skills are
extracted to the tool-specific skill directory. For Claude, this means:

```
.claude/skills/create-story/
.claude/skills/create-task/
.claude/skills/hypothesis-task/
```

Skill directories are tracked in `.swamp/upstream_extensions.json` for cleanup
on uninstall.

## Separation of Concerns

Skills enable a clean split between generic integrations and opinionated
workflows:

```
@webframp/redmine                    ← generic model, anyone can use
@myorg/redmine-workflow              ← org-specific skills, depends on @webframp/redmine
@corp/redmine-security-review        ← another org's skill pack, same model
```

Use `dependencies` in the manifest to declare that your skills-only extension
requires a model extension.

## Example: Skills-Only Extension

A minimal extension that bundles two workflow skills:

**Directory layout:**

```
.claude/skills/
├── create-story/
│   └── SKILL.md
└── hypothesis-task/
    ├── SKILL.md
    └── references/
        └── hypothesis-format.md
manifest.yaml
```

**manifest.yaml:**

```yaml
manifestVersion: 1
name: "@myorg/redmine-workflow"
version: "2026.04.14.1"
description: "Story and hypothesis workflow skills for Redmine"
skills:
  - create-story
  - hypothesis-task
dependencies:
  - "@webframp/redmine"
```

**Push:**

```bash
swamp extension push manifest.yaml
```
