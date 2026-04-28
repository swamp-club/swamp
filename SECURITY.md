# Security Policy

## Supported Versions

Only the latest release of swamp receives security updates. We recommend always
running the most recent version.

## Reporting a Vulnerability

For most bugs — including crashes, unexpected behavior, and general defects —
please [file a public issue](https://swamp-club.com/lab). We prefer open issues
so the community can track progress and discuss.

If the vulnerability involves **secret or credential exposure, data
exfiltration, or any issue where public disclosure could put users at risk**,
please email [security@systeminit.com](mailto:security@systeminit.com) instead.

### What to Include

- **Executive Summary** — a brief description of the vulnerability
- **Impact** — what an attacker could achieve by exploiting it
- **Proof of Concept** — steps to reproduce or sample code
- **Swamp Version** — the version affected
- **Mitigation Steps** (optional) — any suggested fix or workaround

### What to Expect

- We will acknowledge your report within **72 hours**
- We will work with you to understand and validate the issue
- We will develop a fix and coordinate a disclosure timeline
- We will credit you in the release notes (unless you prefer to remain
  anonymous)

## Scope

The following are examples of issues that should be reported privately:

- Secrets or credentials leaked through logs, data files, or error messages
- Extension code that can exfiltrate data outside its intended boundary
- Datastore credential mishandling
- Dependency vulnerabilities that could expose user data

Everything else — general bugs, feature requests, and non-sensitive defects —
should be filed as a
[public issue](https://github.com/systeminit/swamp/issues/new).
