---
name: swamp-issue
description: Submit bug reports and feature requests for swamp. Use when the user wants to report a bug, request a feature, or provide feedback about swamp. Triggers on "bug report", "feature request", "report bug", "request feature", "file bug", "submit bug", "swamp bug", "swamp feature", "feedback", "report issue", "file issue".
---

# Swamp Issue Submission Skill

Submit bug reports and feature requests through the swamp CLI. Issues are
submitted directly to GitHub with appropriate labels.

## Quick Reference

| Task                  | Command                                                |
| --------------------- | ------------------------------------------------------ |
| Report a bug          | `swamp issue bug`                                      |
| Request a feature     | `swamp issue feature`                                  |
| Submit bug (CLI args) | `swamp issue bug --title "Title" --body "Description"` |
| Submit feature (args) | `swamp issue feature --title "Title" --body "Desc"`    |

## Submitting a Bug Report

Report bugs you've encountered while using swamp. The interactive mode opens
your editor with a template to guide your bug report.

**Interactive mode (recommended):**

```bash
swamp issue bug
```

This opens your configured `$EDITOR` with a template containing:

- Title section for a brief description
- Description section for details
- Steps to reproduce
- Environment information
- Additional context

**Non-interactive mode:**

```bash
swamp issue bug --title "CLI crashes on empty input" --body "When running..."
swamp issue bug -t "Title" -b "Body" --json
```

**Labels applied:** `bug`, `external`

## Submitting a Feature Request

Request new features or improvements to swamp.

**Interactive mode (recommended):**

```bash
swamp issue feature
```

This opens your editor with a template containing:

- Title section for a brief description
- Problem statement (what pain point this solves)
- Proposed solution
- Alternatives considered
- Additional context

**Non-interactive mode:**

```bash
swamp issue feature --title "Add dark mode" --body "I'd like..."
swamp issue feature -t "Title" -b "Body" --json
```

**Labels applied:** `enhancement`, `external`

## JSON Output

Both commands support `--json` for machine-readable output:

```bash
swamp issue bug --title "My Bug" --body "Details" --json
```

**Output shape:**

```json
{
  "url": "https://github.com/systeminit/swamp/issues/123",
  "number": 123,
  "type": "bug",
  "title": "My Bug"
}
```

## Requirements

- **GitHub CLI (`gh`)**: Must be installed and authenticated
  - Install: https://cli.github.com/
  - Authenticate: `gh auth login`

## Best Practices for Bug Reports

When submitting a bug report, include:

1. **Clear title**: Summarize the bug in one line
2. **Steps to reproduce**: Numbered list of actions that trigger the bug
3. **Expected vs actual behavior**: What should happen vs what does happen
4. **Environment details**: swamp version, OS, shell
5. **Error messages**: Include any error output (use code blocks)

**Example bug title:**

- Good: "CLI crashes when running workflow with missing input file"
- Bad: "It doesn't work"

## Best Practices for Feature Requests

When submitting a feature request, include:

1. **Clear title**: Summarize the feature in one line
2. **Problem statement**: What pain point this addresses
3. **Proposed solution**: How the feature would work
4. **Alternatives**: Other approaches you've considered

**Example feature title:**

- Good: "Add --dry-run flag to workflow run command"
- Bad: "Make it better"

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
