# Content Sanitization

Scan the drafted title and body for sensitive content before submission. This
applies to all submission paths: bug reports, feature requests, security
reports, extension-scoped reports, and ripples.

## When to Sanitize

After gathering all content (title, body, reproduction steps) and before running
any `swamp issue` command. Do not sanitize during gathering — the original
context is needed for diagnosis. Sanitize the final draft.

## What to Scan For

### Secrets

- API keys, tokens, and passwords (e.g. `sk-...`, `ghp_...`, `AKIA...`,
  `Bearer ...`, `token: ...`)
- JWTs (three dot-separated base64 segments)
- Private keys (`-----BEGIN ... PRIVATE KEY-----`)
- `Authorization` headers and `Cookie` values
- Connection strings with embedded credentials
- Vault expressions: `vault.<name>.<key>` in CEL, `${{ vault.<name>.<key> }}` in
  YAML — replace the key name and vault name

**Placeholder:** `<REDACTED_SECRET>`

### Identifiers

- Organization and repository names that identify the user's employer (e.g.
  `acme-corp/internal-tools`)
- Internal hostnames and domains (e.g. `jenkins.internal.acme.com`)
- Private IP addresses (RFC 1918: `10.x.x.x`, `172.16-31.x.x`, `192.168.x.x`)
- Email addresses (except generic ones like `support@swamp-club.com`)
- Usernames that identify real people

**Placeholders:** `<ORG>`, `<INTERNAL_HOST>`, `<PRIVATE_IP>`, `<EMAIL>`,
`<USERNAME>`

### Paths

- Absolute paths under `/Users/<name>/`, `/home/<name>/`, `C:\Users\<name>\` —
  these reveal the user's OS username and directory structure
- Paths are safe when they use generic prefixes like `/tmp/`, `/usr/local/bin/`,
  or relative paths like `./models/`
- Preserve the path structure but replace the identifying segment:
  `/Users/jdoe/code/acme/project` becomes `/path/to/repo`

**Placeholder:** `/path/to/repo` (or `/path/to/<component>` when multiple
distinct paths appear)

## How to Sanitize

1. Draft the title and body as normal during `gather_details`.
2. Before submission, scan the final content against the categories above.
3. If findings exist:
   - List each finding with the original value and proposed replacement.
   - Ask the user to confirm the redactions.
   - Apply confirmed redactions to the title and body.
4. If no findings, proceed to submission without interruption.

## Judgment Calls

- **Generic system paths** (`/usr/local/bin/swamp`, `/tmp/repro/`) are safe — do
  not redact.
- **Public repository names** (`swamp-club/swamp`, well-known open-source
  projects) are safe.
- **Quoted error output** often contains paths or identifiers from the user's
  environment. Redact the identifying parts while preserving the error structure
  — the error message itself is diagnostic value.
- **swamp-club and swamp.club references** are safe — these are the project's
  own public infrastructure.
- **When uncertain**, flag it to the user rather than silently redacting or
  silently passing through.
