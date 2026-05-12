---
name: swamp-issue
description: Fetch issue details and submit issues to the swamp Lab or route them to the publisher's repository — fetch issue details, file bug reports, feature requests, and security vulnerability reports against swamp itself or against a specific extension, and post follow-up ripples (comments) on existing Lab issues with optional close/reopen. Use when the user wants to view an issue, report a bug, request a feature, disclose a vulnerability, comment on an existing issue, close or reopen an issue, or provide feedback about swamp. Triggers on "bug report", "feature request", "security report", "vulnerability", "report bug", "request feature", "file bug", "submit bug", "swamp bug", "swamp feature", "feedback", "report issue", "file issue", "report against extension", "extension bug", "ripple", "comment on issue", "reply to issue", "follow up on issue", "add comment to issue", "close issue", "reopen issue", "get issue", "view issue", "fetch issue", "issue details", "show issue".
---

# Swamp Issue Skill

Fetch issue details, submit bug reports, feature requests, and security
vulnerability disclosures through the swamp CLI. When logged in
(`swamp auth login`), issues are submitted directly to the swamp.club Lab. When
not logged in, the user is prompted to log in or send via email. The `--email`
flag skips straight to a pre-filled email.

To view an existing issue, use `swamp issue get <number>` — this fetches and
displays the issue's title, type, status, author, body, assignees, and comment
count.

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
| `swamp issue get <number>`    | Fetch and display issue details (title, type, status, author, body, assignees, comment count) |
| `swamp issue bug`             | Title, description, steps to reproduce, environment                                           |
| `swamp issue feature`         | Title, problem statement, proposed solution, alternatives                                     |
| `swamp issue security`        | Title, description, reproduction, affected components, impact                                 |
| `swamp issue ripple <number>` | Free-form markdown body (no title); alias: `swamp issue comment`                              |

**Basic non-interactive examples:**

```bash
swamp issue get 42
swamp issue get 42 --json
swamp issue bug --title "CLI crashes on empty input" --body "When running..." --json
swamp issue feature --title "Add dark mode" --body "I'd like..." --json
swamp issue security --title "..." --body "..." --json
swamp issue bug --email --title "Crash report" --body "Details..."
swamp issue ripple 184 --body "See also #183 for the related finding." --json
swamp issue ripple 327 --body "Fixed in latest build" --close --json
swamp issue ripple 42 --body "Re-opening per discussion" --reopen
swamp issue comment 184 --body "See also #183."
```

## Ripple Constraints

Ripples (described in the intro) have these submission rules:

- Requires `swamp auth login` — there is no email fallback.
- `--body` skips the editor; `--json` requires `--body`.
- The body is plain markdown; the server enforces a 65,536-character limit and
  rejects profanity.
- `--close` and `--reopen` are mutually exclusive. The ripple is posted first;
  the status change is a separate operation. If the status change fails, the
  ripple is still posted (partial success).

**Output shape** (with `--json`):

```json
{
  "issueNumber": 184,
  "commentId": "ripple_abc123",
  "serverUrl": "https://swamp.club"
}
```

With `--close`: adds `"statusChanged": "closed"`. With `--reopen`: adds
`"statusChanged": "open"`. If the status change fails after a successful ripple,
`"statusError"` contains the error message instead.

## Plain Submission Flow (no `--extension`)

1. **Logged in** → submits to Lab API → returns issue number and URL
2. **Not logged in** → prompts: log in now, or send via email
3. **`--email` flag** → opens email client with pre-filled subject/body to
   `support@systeminit.com`

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

See [references/output_shapes.md](references/output_shapes.md) for all other
shapes (email fallback, extension-scoped, refusals, security variants).

## Extension-Scoped Submission (`--extension @collective/name`)

Routes reports to the extension's publisher. `@swamp/*` extensions get tagged
Lab issues; third-party extensions hand off to the publisher's repo (via `gh` or
browser); third-party without a declared repo refuses cleanly. See
[references/extension_routing.md](references/extension_routing.md) for the
routing matrix, examples, and refusal semantics.

## Security Routing

`swamp issue security --extension` checks GitHub Private Vulnerability Reporting
(PVR) before routing — and refuses rather than fall back to a public issue if
PVR is off. See [references/security_routing.md](references/security_routing.md)
for the full PVR-state matrix and rationale.

## Workflow

1. Gather details from the user (bug reproduction steps, feature context, or
   vulnerability description).
2. For extension-scoped reports, confirm the extension is pulled locally with
   `swamp extension list` — if missing, run `swamp extension pull <name>` first.
3. Verify syntax with `swamp help issue`.
4. Run the appropriate command.
5. Verify with the returned issue number / URL (or relay the refusal guidance to
   the user).

### Error Recovery

Map the failure to the right fix rather than retrying blindly:

| Failure signal                                  | Likely cause                | Fix                                                                                     |
| ----------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------- |
| Lab submission returns 401 / "unauthorized"     | Auth token expired          | Run `swamp auth login` and retry                                                        |
| Lab submission times out or 5xx                 | swamp.club outage           | Retry with `--email` to fall back to email submission                                   |
| `gh` handoff errors with auth failure           | `GH_TOKEN` unset or invalid | Run `gh auth login` (or export a valid `GH_TOKEN`); re-run — CLI will retry `gh`        |
| `gh` not installed                              | Missing binary              | No action needed — CLI falls back to `method: "browser"` automatically                  |
| `status: "refused"` with "extension not pulled" | Extension not local         | `swamp extension pull <name>`, then retry                                               |
| `status: "refused"` with "no repository"        | Publisher declared no repo  | Do not retry; relay the guidance field to the user (points at publisher's profile page) |
| `status: "refused"` on `security` command       | PVR disabled on target repo | Do not retry as a public issue; relay guidance to contact publisher privately           |

## Requirements

- Lab submission (`@swamp/*` + plain commands) requires `swamp auth login`.
- Third-party repository routing uses `gh` CLI when available (`GH_TOKEN` env
  var or `gh auth login`) and falls back to browser handoff.
- Extension-scoped commands require the extension to be pulled locally via
  `swamp extension pull`.

## Formatting Issue Content

See [references/formatting.md](references/formatting.md) for bug report and
feature request formatting guidelines with examples.

## Related Skills

| Need                                  | Use Skill               |
| ------------------------------------- | ----------------------- |
| Debug swamp issues                    | swamp-troubleshooting   |
| View swamp source code                | swamp-troubleshooting   |
| Pull an extension before reporting    | swamp-repo              |
| Publish an extension with a repo link | swamp-extension-publish |
