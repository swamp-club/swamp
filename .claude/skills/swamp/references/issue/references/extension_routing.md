# Extension-Scoped Submission

`--extension @collective/name` routes reports to the extension's publisher.
Requires the extension to be pulled locally (`swamp extension pull <name>`) and
the command to run from inside a swamp repo (or pass `--repo-dir <path>`).

## Routing Outcomes

| Collective                  | Destination                                         |
| --------------------------- | --------------------------------------------------- |
| `@swamp/*`                  | swamp.club Lab, tagged with extension metadata      |
| Third-party with repository | Publisher's repo (via `gh` CLI or browser handoff)  |
| Third-party without repo    | Not filed; error points at publisher's profile page |

## Examples

```bash
swamp issue bug --extension @swamp/aws --title "..." --body "..." --json
swamp issue bug --extension @adam/cfgmgmt --title "..." --body "..." --json
swamp issue security --extension @adam/cfgmgmt --title "..." --body "..." --json
```

## Refusal Semantics

When swamp can't file the report, the command fails with a user error (exit
**1**) whose message starts `Report not filed against <name>.` and carries the
guidance. With `--json` the error is `{"error": "...", "code": "<reason>"}` on
stderr, where `code` is `not-pulled`, `no-repository`, or `pvr-disabled`. See
[output_shapes.md](output_shapes.md) for the full shape catalog.
