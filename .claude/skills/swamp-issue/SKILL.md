---
name: swamp-issue
description: Fetch, edit, search, and submit issues to swamp Lab — view details, edit title/body, search/list issues, file bugs/features/security reports, post ripples (comments) with close/reopen, route to extension publishers. Triggers on "bug report", "feature request", "security report", "report bug", "file bug", "submit bug", "swamp bug", "swamp feature", "feedback", "report issue", "file issue", "extension bug", "ripple", "comment on issue", "close issue", "reopen issue", "get issue", "view issue", "fetch issue", "show issue", "edit issue", "update issue", "change issue title", "search issues", "list issues", "find issue", "issue search".
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

## Ripple Constraints

Ripples (described in the intro) have these submission rules:

- Requires `swamp auth login` — there is no email fallback.
- `--body` skips the editor; `--json` requires `--body`.
- The body is plain markdown; the server enforces a 65,536-character limit and
  rejects profanity.
- `--close` and `--reopen` are mutually exclusive. The ripple is posted first;
  the status change is a separate operation. If the status change fails, the
  ripple is still posted (partial success).
- Before posting, sanitize the body for secrets, identifiers, and paths per
  [references/sanitization.md](references/sanitization.md). Ripple bodies often
  contain quoted error output from working sessions — redact identifying parts
  while preserving diagnostic structure.

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
   `support@swamp-club.com`

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

## Bug Report Workflow

A state machine. Each state gates the next — do not advance until the current
state's **Verify** passes. If Verify fails, run **On Failure** and re-verify.

```
gather_details → sanitize → version_check → submit → verify
```

### State 1: gather_details

**Gate:** None (first state).

**Action:** Gather bug details from the user — reproduction steps, affected
component, environment. For extension-scoped reports, confirm the extension is
pulled locally with `swamp extension list` — if missing, run
`swamp extension pull <name>` first. Note which source files you investigated
during diagnosis — you will need these paths in the next state.

**Verify:** Title and body are ready. Ideally you also know which source files
are relevant to the bug (for the version check in the next state).

**On Failure:** Ask the user for more details.

### State 2: sanitize

**Gate:** State 1 passed (title and body are drafted).

**Action:** Scan the drafted title and body for secrets, org-specific
identifiers, and local paths. See
[references/sanitization.md](references/sanitization.md) for the full pattern
list, placeholders, and judgment calls.

**Verify:** One of two outcomes:

- **No findings** — content is clean. Advance silently.
- **Findings exist** — present the redactions to the user and get confirmation
  before advancing.

**On Failure:** If the user rejects a redaction, adjust and re-verify.

### State 3: version_check

**Gate:** State 2 passed (title, body, and diagnosed file paths are known).

**Action:** Check if the bug was already fixed in a newer version. Read
[references/version_check.md](references/version_check.md) for the full
procedure.

**Verify:** One of three outcomes determined:

- **bug_fixed** — the code changed and the bug appears resolved. Tell the user
  to run `swamp update` instead of filing. Do not advance to submit.
- **bug_present** — the code is unchanged or the bug still exists. Advance to
  submit.
- **inconclusive** — could not determine (source fetch failed, comparison
  unclear). Advance to submit.

**On Failure:** If `swamp update --check` or `swamp source fetch` fails, treat
as inconclusive and advance.

### State 4: submit

**Gate:** State 3 passed with `bug_present` or `inconclusive`.

**Action:** Verify syntax with `swamp help issue bug`. Run the command.

**Verify:** The command succeeded and returned an issue number or URL.

**On Failure:** See Error Recovery table below.

### State 5: verify

**Gate:** State 4 passed.

**Action:** Confirm the returned issue number / URL with the user (or relay
refusal guidance).

**Verify:** User acknowledged.

## Feature / Security Workflow

Feature requests and security reports use a linear flow (no version check):

1. Gather details from the user.
2. Sanitize the drafted title and body — scan for secrets, identifiers, and
   paths per [references/sanitization.md](references/sanitization.md). Present
   any findings to the user for confirmation before proceeding.
3. For extension-scoped reports, confirm the extension is pulled locally.
4. Verify syntax with `swamp help issue`.
5. Run the appropriate command.
6. Verify with the returned issue number / URL.

## Error Recovery

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
