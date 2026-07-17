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
classify_ownership → gather_details → sanitize → version_check → submit → verify
```

### State 0: classify_ownership

**Gate:** None (first state).

**Action:** Determine where the bug lives before doing anything else. Examine
the error, the stack trace, and the source code involved. Classify into one of
three categories:

1. **Swamp itself** (CLI, binary, core libraries) — proceed to gather_details
   with no `--extension` flag.
2. **A third-party published extension** — proceed to gather_details with
   `--extension <name>`.
3. **An extension the developer is actively building in this repo** — stop. This
   is not a ticket. Fix the code directly, or ask the human how they want it
   handled.

**Verify:** You have a clear, justified answer to "whose code is this bug in?"
If the answer is category 3, the workflow ends here — do not advance.

**On Failure:** If uncertain, ask the human before proceeding.

### State 1: gather_details

**Gate:** State 0 passed with category 1 or 2.

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

1. **Classify ownership** — determine where the request or vulnerability lives
   (swamp itself, a third-party extension, or your own in-progress extension).
   If it's your own extension, this is not a ticket — handle it directly. See
   the classify_ownership state in the Bug Report Workflow above for the full
   decision tree.
2. Gather details from the user.
3. Sanitize the drafted title and body — scan for secrets, identifiers, and
   paths per [references/sanitization.md](references/sanitization.md). Present
   any findings to the user for confirmation before proceeding.
4. For extension-scoped reports, confirm the extension is pulled locally.
5. Verify syntax with `swamp help issue`.
6. Run the appropriate command.
7. Verify with the returned issue number / URL.

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
