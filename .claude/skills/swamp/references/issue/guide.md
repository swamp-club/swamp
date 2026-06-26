# Swamp Issue Skill

Fetch issue details, submit bug reports, feature requests, and security
vulnerability disclosures through the swamp CLI. When logged in
(`swamp auth login`), issues are submitted directly to the swamp.club Lab. When
not logged in, the user is prompted to log in or send via email. The `--email`
flag skips straight to a pre-filled email.

To view an existing issue, use `swamp issue get <number>` — this fetches and
displays the issue's title, type, status, author, body, assignees, and comment
count.

To edit an existing issue's title or body, use `swamp issue edit <number>`. This
opens `$EDITOR` pre-filled with the current title and body. Use `--title` and/or
`--body` flags to skip the editor. Only the issue author (or admins) can edit.

With `--extension <name>`, reports are routed to the extension's publisher
instead — either as a tagged swamp.club Lab issue (for `@swamp/*` extensions) or
to the publisher's declared repository (for third-party extensions).

To follow up on an existing Lab issue (e.g. add a related finding, link a
sibling issue, or update reproduction steps discovered later), use
`swamp issue ripple <number>` — this posts a comment ("ripple") on the issue.
`swamp issue comment` is an alias for `ripple`. Add `--close` to close the issue
after posting, or `--reopen` to reopen it.

**Verify CLI syntax:** If unsure about exact flags or subcommands, run
`swamp help issue` for the complete, up-to-date CLI schema.

## Commands

`bug`, `feature`, and `security` support interactive mode (opens `$EDITOR` with
a template) and non-interactive mode with `--title` and `--body` flags. `ripple`
takes a positional issue number and either opens the editor or accepts `--body`
directly.

| Command                       | Purpose                                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------------------- |
| `swamp issue search [query]`  | Search or list issues by keyword, with optional `--type`, `--status`, `--source`, `--limit`   |
| `swamp issue get <number>`    | Fetch and display issue details (title, type, status, author, body, assignees, comment count) |
| `swamp issue edit <number>`   | Edit title and/or body of an existing issue (author or admin only)                            |
| `swamp issue bug`             | Title, description, steps to reproduce, environment                                           |
| `swamp issue feature`         | Title, problem statement, proposed solution, alternatives                                     |
| `swamp issue security`        | Title, description, reproduction, affected components, impact                                 |
| `swamp issue ripple <number>` | Free-form markdown body (no title); alias: `swamp issue comment`                              |

**Basic non-interactive examples:**

```bash
swamp issue search vault
swamp issue search --type bug --status open
swamp issue search --source swamp --limit 10 --json
swamp issue get 42
swamp issue get 42 --json
swamp issue edit 42
swamp issue edit 42 --title "Updated title"
swamp issue edit 42 --title "Updated title" --body "Updated body" --json
swamp issue bug --title "CLI crashes on empty input" --body "When running..." --json
swamp issue feature --title "Add dark mode" --body "I'd like..." --json
swamp issue security --title "..." --body "..." --json
swamp issue bug --email --title "Crash report" --body "Details..."
swamp issue ripple 184 --body "See also #183 for the related finding." --json
swamp issue ripple 327 --body "Fixed in latest build" --close --json
swamp issue ripple 42 --body "Re-opening per discussion" --reopen
swamp issue comment 184 --body "See also #183."
```

For detailed walkthroughs of each operation, see [reference.md](reference.md).
