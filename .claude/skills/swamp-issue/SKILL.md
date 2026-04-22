---
name: swamp-issue
description: Submit issues to the swamp Lab or route them to the publisher's repository — file bug reports, feature requests, and security vulnerability reports against swamp itself or against a specific extension. Use when the user wants to report a bug, request a feature, disclose a vulnerability, or provide feedback about swamp. Triggers on "bug report", "feature request", "security report", "vulnerability", "report bug", "request feature", "file bug", "submit bug", "swamp bug", "swamp feature", "feedback", "report issue", "file issue", "report against extension", "extension bug".
---

# Swamp Issue Submission Skill

Submit bug reports, feature requests, and security vulnerability disclosures
through the swamp CLI. When logged in (`swamp auth login`), issues are submitted
directly to the swamp.club Lab. When not logged in, the user is prompted to log
in or send via email. The `--email` flag skips straight to a pre-filled email.

With `--extension <name>`, reports are routed to the extension's publisher
instead — either as a tagged swamp.club Lab issue (for `@swamp/*` extensions) or
to the publisher's declared repository (for third-party extensions).

**Verify CLI syntax:** If unsure about exact flags or subcommands, run
`swamp help issue` for the complete, up-to-date CLI schema.

## Commands

All three commands support interactive mode (opens `$EDITOR` with a template)
and non-interactive mode with `--title` and `--body` flags.

| Command                | Template sections                                             |
| ---------------------- | ------------------------------------------------------------- |
| `swamp issue bug`      | Title, description, steps to reproduce, environment           |
| `swamp issue feature`  | Title, problem statement, proposed solution, alternatives     |
| `swamp issue security` | Title, description, reproduction, affected components, impact |

**Basic non-interactive examples:**

```bash
swamp issue bug --title "CLI crashes on empty input" --body "When running..." --json
swamp issue feature --title "Add dark mode" --body "I'd like..." --json
swamp issue security --title "..." --body "..." --json
swamp issue bug --email --title "Crash report" --body "Details..."
```

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

## Extension-Scoped Submission (`--extension @collective/name`)

Routes reports to the extension's publisher. Requires the extension to be pulled
locally (`swamp extension pull <name>`) and the command to run from inside a
swamp repo (or pass `--repo-dir <path>`).

Three outcomes depending on the extension:

| Collective                  | Destination                                         |
| --------------------------- | --------------------------------------------------- |
| `@swamp/*`                  | swamp.club Lab, tagged with extension metadata      |
| Third-party with repository | Publisher's repo (via `gh` CLI or browser handoff)  |
| Third-party without repo    | Refused cleanly; points at publisher's profile page |

**Non-interactive examples:**

```bash
swamp issue bug --extension @swamp/aws --title "..." --body "..." --json
swamp issue bug --extension @adam/cfgmgmt --title "..." --body "..." --json
swamp issue security --extension @adam/cfgmgmt --title "..." --body "..." --json
```

**Output shapes (`--json`):**

- `@swamp/*` →
  `{ "method": "extension-lab", "number": 42, "extensionName": "@swamp/aws", ... }`
- Third-party with `gh` →
  `{ "status": "handoff", "method": "gh", "variant": "issue", "url": "...", "number": 42 }`
- Third-party without `gh` →
  `{ "status": "handoff", "method": "browser", "variant": "issue", "url": "...", "preparedTitle": "...", "preparedBody": "..." }`
- Refused (not pulled / no repo / PVR disabled for security) →
  `{ "status": "refused", "reason": "...", "guidance": "..." }`

Refusals exit **0**, not as errors — the CLI is honoring the user's intent when
the target can't accept reports.

## Security Routing

`swamp issue security --extension` against a third-party GitHub repository
checks GitHub's Private Vulnerability Reporting (PVR) status first:

- **PVR enabled** → opens the advisory form in the browser.
- **PVR disabled** → **refuses**. The CLI never falls back to creating a public
  issue for a security report, because that would silently publish the
  vulnerability. The guidance tells the reporter to contact the publisher
  privately and tells the publisher how to enable PVR.
- **Check failed or `gh` unavailable** → opens the advisory URL with a fallback
  issue URL surfaced in the output.

## Workflow

1. Gather details from the user (bug reproduction steps, feature context, or
   vulnerability description).
2. For extension-scoped reports, confirm the extension is pulled locally.
3. Verify syntax with `swamp help issue`.
4. Run the appropriate command.
5. Verify with the returned issue number / URL (or relay the refusal guidance to
   the user).

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
