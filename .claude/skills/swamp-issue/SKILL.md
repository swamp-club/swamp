---
name: swamp-issue
description: Submit issues to the swamp Lab — file bug reports with reproduction steps or submit feature requests with implementation context. Use when the user wants to report a bug, request a feature, or provide feedback about swamp. Triggers on "bug report", "feature request", "report bug", "request feature", "file bug", "submit bug", "swamp bug", "swamp feature", "feedback", "report issue", "file issue".
---

# Swamp Issue Submission Skill

Submit bug reports and feature requests through the swamp CLI. When logged in
(`swamp auth login`), issues are submitted directly to the swamp.club Lab. When
not logged in, the user is prompted to log in or send via email. The `--email`
flag skips straight to a pre-filled email.

**Verify CLI syntax:** If unsure about exact flags or subcommands, run
`swamp help issue` for the complete, up-to-date CLI schema.

## Submission Flow

1. **Logged in** → submits to Lab API → returns issue number and URL
2. **Not logged in** → prompts: log in now, or send via email
3. **`--email` flag** → opens email client with pre-filled subject/body to
   `support@systeminit.com`

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
swamp issue bug --email --title "Crash report" --body "Details..."
```

**Output shape** (Lab submission with `--json`):

```json
{
  "method": "lab",
  "number": 42,
  "type": "bug",
  "title": "My Bug",
  "serverUrl": "https://swamp.club"
}
```

**Verify submission:** Check the returned URL at
`https://swamp.club/lab/<number>`.

## Workflow

1. Gather details from the user (bug reproduction steps or feature context)
2. Verify syntax with `swamp help issue`
3. Run the appropriate command (`swamp issue bug` or `swamp issue feature`)
4. Verify with the returned issue number or URL

## Requirements

Requires `swamp auth login` for Lab submission. Use `--email` as alternative
when not logged in.

## Formatting Issue Content

See [references/formatting.md](references/formatting.md) for bug report and
feature request formatting guidelines with examples.

## Related Skills

| Need                   | Use Skill             |
| ---------------------- | --------------------- |
| Debug swamp issues     | swamp-troubleshooting |
| View swamp source code | swamp-troubleshooting |
