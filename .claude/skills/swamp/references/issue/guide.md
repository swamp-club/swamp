# Swamp Issue Skill

Fetch issue details, submit bug reports, feature requests, and security
vulnerability disclosures through the swamp CLI. When logged in
(`swamp auth login`), issues are submitted directly to the swamp.club Lab. When
not logged in, the user is prompted to log in or send via email. The `--email`
flag skips straight to a pre-filled email.

To view an existing issue, use `swamp issue get <number>` — this fetches and
displays the issue's title, type, status, author, body, assignees, and comment
count.

To edit an existing issue's title, body, or type, use
`swamp issue edit <number>`. This opens `$EDITOR` pre-filled with the current
title, type, and body. Use `--title`, `--body`, and/or `--type` flags to skip
the editor. Only the issue author (or admins) can edit. Authors can change the
type to `security` to restrict visibility, but cannot change it back from
`security` — only admins can de-escalate.

## Ownership Classification

Before filing any report (bug, feature, or security), classify where the issue
lives:

1. **Swamp's own CLI/binary behavior** — file against swamp itself with no
   `--extension` flag.
2. **A third-party published extension you don't control** — file with
   `--extension <name>` to route it to that extension's publisher.
3. **An extension you (or the human you're working with) are actively developing
   in this repo's own source tree** — this is not a ticket. Fix the code
   yourself, or ask the human how they want it handled. Do not file an issue.

This step is mandatory. Do not skip it — even if you just filed a legitimate
swamp bug, re-classify before every subsequent report. The failure mode this
prevents is pattern-matching from one correct filing to subsequent incorrect
ones without re-checking the premise.

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
| `swamp issue edit <number>`   | Edit title, body, or type of an existing issue (author or admin only)                         |
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
swamp issue edit 42 --type security
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
