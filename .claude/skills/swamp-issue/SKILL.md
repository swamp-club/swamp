---
name: swamp-issue
description: Create GitHub issues for swamp — file bug reports with reproduction steps or submit feature requests with implementation context. Use when the user wants to report a bug, request a feature, or provide feedback about swamp. Triggers on "bug report", "feature request", "report bug", "request feature", "file bug", "submit bug", "swamp bug", "swamp feature", "feedback", "report issue", "file issue".
---

# Swamp Issue Submission Skill

Submit bug reports and feature requests through the swamp CLI. Issues are
submitted directly to GitHub with appropriate labels.

**Verify CLI syntax:** If unsure about exact flags or subcommands, run
`swamp help issue` for the complete, up-to-date CLI schema.

## Commands

Both commands support interactive mode (opens `$EDITOR` with a template) and
non-interactive mode with `--title` and `--body` flags.

| Command               | Labels                    | Template sections                                         |
| --------------------- | ------------------------- | --------------------------------------------------------- |
| `swamp issue bug`     | `bug`, `needs-triage`     | Title, description, steps to reproduce, environment       |
| `swamp issue feature` | `feature`, `needs-triage` | Title, problem statement, proposed solution, alternatives |

**Non-interactive examples:**

```bash
swamp issue bug --title "CLI crashes on empty input" --body "When running..." --json
swamp issue feature --title "Add dark mode" --body "I'd like..." --json
```

**Output shape** (both commands with `--json`):

```json
{
  "url": "https://github.com/systeminit/swamp/issues/123",
  "number": 123,
  "type": "bug",
  "title": "My Bug"
}
```

**Verify submission:** Check the returned `url` or run `gh issue view <number>`
to confirm the issue was created.

## Workflow

1. Gather details from the user (bug reproduction steps or feature context)
2. Verify syntax with `swamp help issue`
3. Run the appropriate command (`swamp issue bug` or `swamp issue feature`)
4. Verify with the returned URL

## Requirements

Requires authenticated `gh` CLI.

## Formatting Issue Content

See [references/formatting.md](references/formatting.md) for bug report and
feature request formatting guidelines with examples.

## Related Skills

| Need                   | Use Skill             |
| ---------------------- | --------------------- |
| Debug swamp issues     | swamp-troubleshooting |
| View swamp source code | swamp-troubleshooting |
