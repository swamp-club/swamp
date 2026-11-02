---
audience: everyone
last-verified: 2026-11-02 @ HEAD
---

# Account notices

Swamp Club tells a signed-in user when their trial is about to end, and when it
has ended. The web shows a banner (swamp-club#4262). The CLI prints the same
two notices after a command, from the API below. swamp-club decides who sees
which notice: the CLI holds no billing rules of its own. Both sides test against
`src/infrastructure/http/account_notices_response.fixture.json`.

## Contract

`GET /api/v1/account/notices`, with the user's API key in the `x-api-key`
header, as `/api/whoami` takes it (swamp-club#4262, swamp-club#4268).

| Answer                                 | Meaning                                       | CLI outcome                            |
| -------------------------------------- | --------------------------------------------- | -------------------------------------- |
| `200 {"notices":[…]}`                  | The user's notices, most urgent first         | `ok`                                   |
| `403 {"error":"notices_require_user"}` | A collective API key: it works, has no notice | `unavailable`: stop for the key        |
| `401`                                  | Unknown or revoked key, or a proxy's          | `rejected`: drop notices, retry in 24h |
| `404`                                  | A server without the endpoint                 | `unsupported`: ask again in 24h        |
| `429`                                  | Rate limited, with `Retry-After` when given   | `backoff`                              |
| anything else, a timeout               |                                               | `failed`                               |

Only the exact `notices_require_user` body means a collective key; any other
`403` is a gateway's and is a failure. swamp-club returns notices for the
collectives the user owns, and the non-personal ones they administer, ordered
`trial-ended`, `seats-exceeded`, then `trial-ending` by soonest end. Each notice
carries `kind`, `slug`, `name`, `personal` and `href`, a relative billing path
(`/billing` for a personal collective, `/o/<slug>/billing` for a team).
`trial-ending` also carries `endsAt` (ISO 8601) and `daysRemaining`.

## What the client accepts

The answer is untrusted, so it is held to these rules before anything uses it
(`src/infrastructure/http/account_notice_schemas.ts`):

- **Only the trial kinds.** `trial-ended` and `trial-ending` are kept.
  `seats-exceeded` stays on the web, and an unknown kind is dropped, so kinds
  added later never break the CLI. A malformed notice is dropped, never fatal.
- **Bounded.** The body is read up to 64 KiB, and at most 20 notices are kept,
  so whatever parses always fits the cache.
- **Clean text.** `slug` must be a collective slug (`[a-z0-9_-]`, at most 64).
  `name` loses terminal escapes, control, bidi and zero-width characters, is
  one line of at most 120 code points, and a name left empty, or holding
  only zero-width joiners, drops the notice.
- **A link never leaves the server.** `href` is kept only when it is a relative
  path of printable ASCII only, with one leading slash and no backslash, that
  resolves on the same origin. Any space, Unicode spaces included, is refused,
  so server text can never print a second URL after the real one. The CLI joins
  it onto the configured server. A refused `href` falls back to the billing page
  swamp would open itself, so server text can never send the user to another
  host.

## How the CLI uses it

- **The poll.** It runs in the background on the commands that poll the inbox
  (`workflow run`, `behavior run` / `model method run`, `extension pull`,
  `extension push`), on the inbox's schedule: no sooner than 15 minutes after
  the last poll, never more than 7 days apart, honouring `Retry-After`. It is
  capped at 5 seconds and settled at teardown, as the inbox poll is: teardown
  waits up to 250 ms more for it, then aborts it, and an aborted poll counts as
  a poll. While the cache holds an ended trial, any eligible command may poll
  too, still at most every 15 minutes, so a plan bought on the web normally
  clears the notice within one window whatever commands the user runs. Such a
  fast command waits up to 1.5 s for its poll at teardown rather than 250 ms,
  since it has little runtime of its own for the request to finish in; on a
  link slower than that, the notice clears at the next slow command,
  `subscription status` or login. `swamp auth login` fetches once after it has
  reported the login, so a new signup has its trial cached from the start, and
  `swamp subscription status` fetches and shows the notices. A process that
  cannot write the cache does not poll. `auth logout` deletes the key's state.
- **A refused key shows nothing.** `unavailable` (the exact
  `notices_require_user` body) stops polling for the key for good and drops its
  cached notices; an answer to a request sent before the stop is ignored. A
  `401` also drops the cached notices, so it can never leave an ended notice
  printing that no poll could clear, but it only waits a day before asking
  again: a `401` may come from a proxy or a brief outage, and a key that still
  works must get its notices back. It keeps the record of what already showed,
  so a quick recovery never shows the same notice twice in a day.
- **The cache.** One file per API key per server, in
  `account-notices-v1/<hash>.json` under the swamp config directory, on the
  inbox cache's terms: neither the key nor the server's URL is stored, files are
  owner-only, at most eight keys are kept, and a file that is missing, corrupt
  or out of bounds reads as a key never polled. It holds the last good answer,
  the schedule, and when each notice last showed. Changes are additive only; a
  breaking change moves to a new directory.
- **The notice.** After a command that succeeded, the CLI prints at most one
  notice, the first that has not shown in the last 24 hours, to stderr in log
  mode. It prints last, after the inbox notice and the update banner:

  ```
  ⚠ Your Swamp Club trial has ended.
    Choose a plan:  https://swamp-club.com/billing
  ```

  ```
  ℹ Your Swamp Club trial ends in 5 days (2026-11-07).
    Choose a plan:  https://swamp-club.com/billing
  ```

  A team's trial names it by its slug, since the free-text name could carry a
  fake link: `⚠ The Swamp Club trial for acme has ended.` With a
  day or less left, an ending trial reads `ends within a day`. Only the label is
  coloured. The date is the UTC date of `endsAt`, as `subscription status`
  prints trial ends. The notice is decided from the cache alone, so it costs no
  request.
- **Ended as soon as it ends.** A cached `trial-ending` whose `endsAt` has
  passed on the local clock shows as ended at once, with no request, and a
  showing of the ending notice earlier that day does not hold it back. The next
  poll confirms it.
- **The day count is computed, not stored.** The CLI shows
  `ceil((endsAt − now) / 1 day)`, swamp-club's own formula (`trialStatus` in its
  `lib/trial.ts`): elapsed milliseconds rounded up, with no calendar or
  timezone, so it matches the server for a fresh answer and stays right as the
  cache ages. A stored count would be days stale for someone who mostly runs
  fast commands. It is never more than the server's `daysRemaining`, so a clock
  running behind can only lower it, and never less than one while the trial
  runs. This departs from swamp-club#4276's text, which said to show
  `daysRemaining` as given; the timezone bug that warned against is counting
  local calendar days, which this does not do.
- **No off switch.** No environment variable turns the notice off: not `CI`,
  not `SWAMP_NO_INBOX_NOTICE`, not `SWAMP_NO_UPDATE_CHECK`. It is billing state,
  not a message. It still never prints where it would break output: in `--json`
  mode, with `-q`, after a failed command, or in a nested run (a swamp started
  by another swamp), whose output its parent captures. The same commands that
  never show the inbox notice never show this one: every command the auth gate
  exempts, `inbox`, `subscription`, `auth`, `serve`, `worker`, `start` and
  `dashboard`, and it never polls from an agent hook (`audit record`) or the
  worker's dispatch runner, which return before teardown. A collective key gets `notices_require_user` and stops, so CI
  running on one never sees it.
