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
| `swamp issue bug`     | `bug`, `external`         | Title, description, steps to reproduce, environment       |
| `swamp issue feature` | `enhancement`, `external` | Title, problem statement, proposed solution, alternatives |

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

## Requirements

- **GitHub CLI (`gh`)**: Must be installed and authenticated
  - Install: https://cli.github.com/
  - Authenticate: `gh auth login`

## For AI Agents: Formatting Issue Content

When helping users create issues, follow these guidelines:

### Bug Reports

Provide a summary of the work involved to fix the bug:

- Describe what component is affected
- Outline the expected fix approach at a high level
- Do NOT include specific code implementations

**Example summary:**

> This bug affects the workflow execution service when input files are missing.
> The fix would involve adding validation in the input resolution phase before
> job execution begins, with a clear error message pointing to the missing file.

### Feature Requests

Provide a summary of the implementation plan:

- Describe the scope of changes needed
- List affected components
- Outline the high-level approach
- Do NOT include specific code implementations

**Example summary:**

> This feature would add a `--dry-run` flag to the `workflow run` command.
> Changes would be needed in:
>
> - Command option parsing (workflow_run.ts)
> - Execution service to skip actual method calls
> - Output rendering to show what would be executed
>
> The approach would intercept execution at the method call boundary and display
> the planned actions without making external calls.

## Troubleshooting

**"GitHub CLI (gh) is not installed"** Install the GitHub CLI from
https://cli.github.com/

**"GitHub CLI is not authenticated"** Run `gh auth login` and follow the prompts
to authenticate.

**Editor doesn't wait for input (GUI editors)** The CLI auto-detects terminal vs
GUI editors. For GUI editors like VS Code, the `--wait` flag is automatically
added. If your editor doesn't wait, set `$EDITOR` to a terminal-based editor
like `vim` or `nano`.

## Related Skills

| Need                   | Use Skill             |
| ---------------------- | --------------------- |
| Debug swamp issues     | swamp-troubleshooting |
| View swamp source code | swamp-troubleshooting |
