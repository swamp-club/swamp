---
audience: everyone
last-verified: 2026-10-26 @ HEAD
---

# Inbox

Swamp Club keeps an inbox of messages for each user: announcements, updates on
the user's issues, points, and direct notes from the team. The CLI reads it
through the API below. Swamp Club builds its endpoints from this document, and
both sides test against the same fixture,
`src/infrastructure/http/inbox_responses.fixture.json`.

## Contract

Every endpoint authenticates with the user's API key in the `x-api-key` header,
as `/api/whoami` does. Messages belong to a user. A broadcast is delivered as
one copy per user, so read state is per user.

| Endpoint                      | Request                                                                                   | Response                                                                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/inbox/summary`      | Optional `If-None-Match: <etag>`                                                          | `200` with an `ETag` header and `{ unread, newestId, newestAt, pollAfterSeconds }`, or `304` with no body when unchanged                |
| `GET /api/inbox/messages`     | `?status=unread\|all` (default `unread`), `&limit=` (default 50, max 100), `&before=<id>` | `200 { messages: Message[], nextCursor: string \| null }`, newest first                                                                 |
| `GET /api/inbox/messages/:id` | none                                                                                      | `200 Message`; `404` when the message is not the caller's                                                                               |
| `POST /api/inbox/read`        | `{ ids: string[] }`, at most 100                                                          | `200 { read: string[] }`: the ids now read that belong to the caller. Idempotent; ids that are unknown or not the caller's are left out |

```
InboxSummary {
  unread: number              // count of unread messages
  newestId: string | null     // newest unread message id
  newestAt: string | null     // ISO 8601
  pollAfterSeconds: number    // the CLI waits at least this long before polling again; floor 900
}

Message {
  id: string                  // ULID: sortable, so "newer than" is a string compare
  kind: string                // "announcement" | "issue_update" | "points" | "direct" today; a string so new kinds still parse
  title: string               // one line, plain text, at most 120 characters
  body: string                // markdown, at most 8 KiB
  createdAt: string           // ISO 8601
  link?: string               // https URL on the Swamp Club site
  action?: { label: string, command: string }   // e.g. { "label": "Update now", "command": "swamp update" }
  readAt: string | null       // ISO 8601
}
```

Status codes that apply to every endpoint:

- `401`: the key is unknown or revoked.
- `403` with `{ "error": "inbox_requires_user" }`: a collective API key. The
  inbox belongs to a person, not a collective.
- `404` on `/summary` or `/messages`: the server has no inbox (an older or
  self-hosted Swamp Club).
- `429` with `Retry-After`: back off.

## What the client accepts

`SwampClubClient` (`src/infrastructure/http/swamp_club_client.ts`) treats every
response as untrusted. The schemas in `src/infrastructure/http/inbox_schemas.ts`
translate it into swamp's own values, so nothing past them sees raw server text:

- **Terminal escapes are stripped.** `kind`, `title` and `action` are reduced to
  one line with no ANSI escape sequences or control characters. `body` keeps
  newlines and tabs and loses every other control character.
- **An action is always a single, plain `swamp` command.** The command must be
  `swamp` followed by words made of letters, digits and the characters `@`, `%`,
  `+`, `,`, `.`, `/`, `:`, `=`, `_` and `-`, such as `swamp update` or
  `swamp extension pull @swamp/aws-ec2`. Quotes, `;`, `|`, `&`, `$`, backticks,
  redirects, globs and `~` are refused, so the text can never chain or
  substitute a second command after `swamp`. A command that breaks this, or is
  longer than 200 characters, drops the action; the message is kept. A command
  is never shortened, because a shortened command would not run.
- **A link is always `https:`, with no username or password.** Any other link is
  dropped; the message is kept.
- **Ids are ULIDs and dates are ISO 8601.** A message that breaks either, or
  whose body is over 8 KiB, is dropped and the rest of the list is kept. The
  page reports how many it dropped, so a server that drifts from this contract
  shows up rather than losing messages silently. An over-long title is
  shortened.
- **`pollAfterSeconds` is passed through as sent.** The poller enforces the
  900-second floor.

`inboxSummary` never throws. It answers `ok`, `not_modified`, `unsupported`
(404), `unavailable` (403 `inbox_requires_user`), `rejected` (401), `backoff`
(429, with the `Retry-After` seconds) or `failed` (a timeout, a refused
connection, a 5xx, a gateway's 403 or a malformed body). It does not retry, and
the caller's signal is its only timeout, so a `Retry-After` wait can never hold
up the command it runs behind.

The list, get and mark-read calls are for commands the user runs, so they throw
a `UserError` with a plain message. They name the server's `error` field when
there is one and never echo a raw response body. `markInboxRead` removes
duplicate ids, sends them in batches of 100, and returns only the requested ids
the server confirmed. If a later batch fails, the earlier ones have already been
applied; marking read is idempotent, so retrying the whole call is safe.

## How the CLI uses it

- **The poll.** Slow commands ask `/api/inbox/summary` in the background, with
  the `ETag` from the last answer, and no sooner than `pollAfterSeconds` after
  it. The gap is at least 900 seconds and at most 7 days, whatever the server
  sends, so a misbehaving server cannot silence the inbox for good. Every poll
  counts, a failed one included. A `backoff` waits out `Retry-After`.
  `unsupported` asks again 24 hours later, since a server can add the inbox in
  a later upgrade. `unavailable` and `rejected` stop the poll for that key, and
  the cache records why and when.
- **The cache.** The last summary and its `ETag` are cached locally, so a `304`
  costs nothing and the notice needs no network call. Each API key has its own
  file, `inbox/<fingerprint>.json` in the swamp config directory, so a personal
  key and a collective key never share or overwrite state; the file holds the
  key's fingerprint, never the key. At most 8 keys are kept and the least
  recently saved is dropped. A file that is missing, corrupt or out of bounds
  reads as a key never polled. Changes to the file format are additive only,
  and each added field must be safe to lose, since an older swamp drops fields
  it does not know when it saves. A breaking change moves to a new directory,
  so two installed versions never share a file.
- **The notice.** After a command finishes, the CLI prints a notice when there
  are unread messages newer than the last one it announced. It goes to stderr,
  in log mode only, after the command's output:

  ```
  ℹ A new message from Swamp Club is waiting for you.
    To read it:  swamp inbox read
  ```

  With more than one unread message, the first line reads
  `ℹ 3 new messages from Swamp Club are waiting for you.` The second line never
  changes; its `To …:` label matches `To approve:` and `To signal:` in the
  workflow renderer. The text is fixed: no message title or other server text
  appears in it, so an agent's context holds nothing Swamp Club wrote until the
  user asks to read the inbox. The notice never appears in `--json` mode, so an
  agent running commands with `--json` never sees it, and JSON output never
  carries it. The `swamp` skill quotes the second line, so the two must change
  together. A notice retires after 24 hours, whether or not the user reads the
  message.
- **The commands.** `swamp inbox` lists messages and `swamp inbox read` shows
  one and marks it read.
