# Linked Issues and Duplicates

Read this when one piece of work fixes more than one swamp-club issue, or when
an issue reports a problem another issue already covers. Do not close the extra
issue. Link it, or ship it as a duplicate, so its reporter sees it ship.

## Contents

- Which method to use
- Linking an issue (`link_issue`)
- What moves with the primary issue
- Closing out a lifecycle that carries linked issues
- Unlinking (`unlink_issue`)
- Shipping a duplicate (`mark_duplicate`)

## Which method to use

| Situation                                                          | Do this                                                 |
| ------------------------------------------------------------------ | ------------------------------------------------------- |
| The work for issue N also fixes issue M                            | `link_issue` on N with `relationship=related_to`        |
| M reports the same problem as N, and N is still in flight          | `link_issue` on N with `relationship=duplicate_of`      |
| M reports the same problem as N, and N has already shipped         | `start` M's lifecycle, then `mark_duplicate` on M       |
| M reports the same problem as N, and N was closed without shipping | Neither. Work M on its own lifecycle, or ask the human. |

N is the **primary** issue: its lifecycle carries the plan, verification,
attestation and PR. Linked issues follow it.

## Linking an issue

Before linking M, check that M has no lifecycle of its own in progress. The
model cannot see another lifecycle's local state:

```
swamp data query 'modelName == "issue-<M>" && name == "state-main"' --select content --json
```

If `results` has an entry whose `phase` is anything other than `done`, ask the
human which lifecycle should carry the work. Do not link it.

```
swamp model @swamp/issue-lifecycle method run link_issue issue-<N> \
  --input issueNumber=<M> \
  --input relationship=related_to \
  --input reason="<why the same work fixes it>"
```

`link_issue` can run in any phase from `triaging` to `releasing`, and does not
change N's phase. It:

- creates the relationship in swamp-club: `related_to` (shown as "Sibling of")
  from N to M, or `duplicate_of` from M to N;
- walks M forward to N's current status, reopening M first if it was closed;
- records N's PR on M if `link_pr` has already run;
- is idempotent, so linking M again updates it in place.

It refuses to link N to itself, an issue that has already shipped, or a security
issue with a non-security one (in either direction). The same rule holds
afterwards: `triage` or `fast_forward` refuses to change N's type in a way that
breaks it, until the linked issue is unlinked. Changing how an issue is linked
(`related_to` to `duplicate_of`) also needs `unlink_issue` first. It warns, but
still links, when M is already related to another issue that has not shipped.

## What moves with the primary issue

- **Status.** `triage`, `approve`, `fast_forward`, `ship` and `complete` move
  every linked issue with N. A failure to move one fails the method, and
  re-running it is safe.
- **PR.** `link_pr` records the PR on N and on every linked issue, so each
  reporter's shipped notification links it.
- **Milestones.** Linked issues get a short "via #N" entry for
  `implementation_started`, `verification_passed`, `attestation_posted`,
  `pr_linked`, `pr_merged`, `pr_failed`, `shipped` and `complete`. These entries
  never carry free text such as failure reasons, release notes or N's title,
  because N may be restricted to admins. If one fails to post, the method warns
  instead of failing.
- **Attestation.** Posted once, on N. It is keyed by commit, not by issue.
- **Not copied.** Plans, reviews, approval, classification and verification
  failures stay on N.

## Closing out a lifecycle that carries linked issues

`notify` also thanks each linked issue's author unless they are on the team
roster. `force` applies only to the primary issue's author. A failed linked
ripple only warns.

`summarize` requires one outcome for each linked issue, and each must be named
exactly once:

```
swamp model @swamp/issue-lifecycle method run summarize issue-<N> \
  --input originalProblem="<problem>" \
  --input deliveredOutcome="<outcome>" \
  --input outcomeMet=true \
  --input linkedOutcomes='[{"issueNumber":<M>,"deliveredOutcome":"<what M got>","outcomeMet":true}]'
```

Set `outcomeMet=false` for an issue the work only partly fixed.

## Unlinking

```
swamp model @swamp/issue-lifecycle method run unlink_issue issue-<N> \
  --input issueNumber=<M> --input reason="<why>"
```

This removes M from the lifecycle and deletes the swamp-club relationship. M's
status stays where it is, because swamp-club has no backward transitions. Tell
the human if M should be closed or re-triaged by hand.

## Shipping a duplicate

When N has already shipped, M gets a lifecycle of its own:

```
swamp model @swamp/issue-lifecycle method run start issue-<M> --input issueNumber=<M>
swamp model @swamp/issue-lifecycle method run mark_duplicate issue-<M> \
  --input of=<N> --input reason="<why it is the same problem>"
```

`mark_duplicate` runs from `triaging` or `classified`. It links M `duplicate_of`
N, records N's PR on M, walks M to shipped (reopening it first if it was
closed), and moves the phase to `notify`. Finish with `notify` and `summarize`
as usual. The thank-you names #N and its PR.

It looks for N's PR on the issue first, then in N's `pr_merged` or `pr_linked`
lifecycle entry. If neither has one, pass `--input prUrl=<URL>` (http or https
only). With no PR anywhere, M still ships and the entry says no PR was found.

It refuses while M's lifecycle carries linked issues; unlink them first. It
refuses while N is still in flight, and its error gives the `link_issue` command
to run on N instead. It also refuses when N was closed without shipping, and
swamp-club refuses duplicate chains.
