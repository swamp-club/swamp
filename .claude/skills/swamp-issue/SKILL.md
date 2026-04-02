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
swamp issue bug --repo systeminit/swamp-extensions --title "@swamp/aws-ec2: describe fails for stopped instances" --body "..." --json
swamp issue feature --repo systeminit/swamp-extensions --title "@swamp/aws-s3: add bucket lifecycle rules" --body "..." --json
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

## Extension Issue Routing

When an issue relates to an official swamp extension (`@swamp/*` or `@si/*`
collective), route it to the extensions repository using
`--repo
systeminit/swamp-extensions`. If the issue is about the swamp CLI,
runtime, workflow engine, or core framework, omit `--repo` (defaults to
`systeminit/swamp`).

**Indicators that an issue is extension-related:**

- The user mentions a specific extension by name (e.g., `@swamp/aws-ec2`)
- The problem occurs during a model method that belongs to an extension
- The feature request is about adding or improving an extension model capability
- Error messages reference extension model code or types

**Indicators that an issue is core swamp:**

- CLI crash or incorrect output unrelated to a specific extension
- Workflow engine, DAG execution, or scheduling issues
- Vault, datastore, or driver framework bugs
- General UX or configuration issues

When in doubt, ask the user whether the problem is with swamp itself or with a
specific extension.

## Workflow

1. Gather details from the user (bug reproduction steps or feature context)
2. **Determine target repository:** If the issue involves an official extension
   (`@swamp/*` or `@si/*`), use `--repo systeminit/swamp-extensions`
3. Verify syntax with `swamp help issue`
4. Run the appropriate command (`swamp issue bug` or `swamp issue feature`)
5. Verify with the returned URL

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
