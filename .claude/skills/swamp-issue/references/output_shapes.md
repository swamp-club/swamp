# Output Shapes

JSON output shapes for `swamp issue *` commands invoked with `--json`. Use these
to assert on results programmatically.

## Issue Get (`swamp issue get <number> --json`)

```json
{
  "number": 42,
  "title": "Add swamp issue get CLI command",
  "type": "feature",
  "status": "open",
  "author": "stack72",
  "body": "## Problem\n\nThe swamp CLI can submit issues...",
  "assignees": ["alice", "bob"],
  "commentCount": 3,
  "serverUrl": "https://swamp.club"
}
```

## Plain Submission (no `--extension`)

**Lab submission** (user logged in):

```json
{
  "method": "lab",
  "number": 42,
  "type": "bug",
  "title": "My Bug",
  "serverUrl": "https://swamp.club"
}
```

**Email fallback** (`--email` or not logged in and user chose email):

```json
{
  "method": "email",
  "to": "support@systeminit.com",
  "subject": "...",
  "body": "..."
}
```

## Extension-Scoped Submission (`--extension @collective/name`)

**`@swamp/*` — Lab with extension tag:**

```json
{
  "method": "extension-lab",
  "number": 42,
  "extensionName": "@swamp/aws",
  "type": "bug",
  "title": "..."
}
```

**Third-party with `gh` CLI available:**

```json
{
  "status": "handoff",
  "method": "gh",
  "variant": "issue",
  "url": "https://github.com/publisher/repo/issues/42",
  "number": 42
}
```

**Third-party without `gh` (browser handoff):**

```json
{
  "status": "handoff",
  "method": "browser",
  "variant": "issue",
  "url": "https://github.com/publisher/repo/issues/new?...",
  "preparedTitle": "...",
  "preparedBody": "..."
}
```

**Refused** (extension not pulled, publisher declared no repo, or PVR disabled
for a security report):

```json
{
  "status": "refused",
  "reason": "...",
  "guidance": "..."
}
```

Refusals exit **0**, not as errors — the CLI is honoring the user's intent when
the target can't accept reports.

## Security-Specific Variants

For `swamp issue security --extension` against a third-party GitHub repo, the
`variant` field changes based on GitHub's Private Vulnerability Reporting (PVR)
status:

- PVR enabled → `variant: "advisory"`, URL points at the advisory form.
- PVR disabled → `status: "refused"` with guidance to contact the publisher
  privately.
- Check failed or `gh` unavailable → `variant: "advisory"` with a `fallbackUrl`
  field pointing at the public issue URL.
