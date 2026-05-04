# Security Routing

`swamp issue security --extension` against a third-party GitHub repository
checks GitHub's Private Vulnerability Reporting (PVR) status first.

## Outcomes by PVR State

- **PVR enabled** → opens the advisory form in the browser.
- **PVR disabled** → **refuses**. The CLI never falls back to creating a public
  issue for a security report, because that would silently publish the
  vulnerability. The guidance tells the reporter to contact the publisher
  privately and tells the publisher how to enable PVR.
- **Check failed or `gh` unavailable** → opens the advisory URL with a fallback
  issue URL surfaced in the output.

## Why Refuse Instead of Falling Back

A security report routed to a public issue tracker leaks the vulnerability to
anyone watching the repo before the publisher can react. The CLI treats refusal
as the correct outcome — exit 0, with explicit guidance — rather than a failure.
