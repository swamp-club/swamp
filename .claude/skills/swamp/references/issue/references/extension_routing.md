# Extension-Scoped Submission

`--extension @collective/name` routes reports to the extension's publisher.
Requires the extension to be pulled locally (`swamp extension pull <name>`) and
the command to run from inside a swamp repo (or pass `--repo-dir <path>`).

## Routing Outcomes

| Collective                  | Destination                                         |
| --------------------------- | --------------------------------------------------- |
| `@swamp/*`                  | swamp.club Lab, tagged with extension metadata      |
| Third-party with repository | Publisher's repo (via `gh` CLI or browser handoff)  |
| Third-party without repo    | Refused cleanly; points at publisher's profile page |

## Examples

```bash
swamp issue bug --extension @swamp/aws --title "..." --body "..." --json
swamp issue bug --extension @adam/cfgmgmt --title "..." --body "..." --json
swamp issue security --extension @adam/cfgmgmt --title "..." --body "..." --json
```

## Refusal Semantics

Output shapes differ by routing path (`extension-lab`, `gh` handoff, browser
handoff, refusal). Refusals exit **0**, not as errors — the CLI is honoring the
user's intent when the target can't accept reports. See
[output_shapes.md](output_shapes.md) for the full shape catalog.
