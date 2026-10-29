---
audience: everyone
last-verified: 2026-10-28 @ HEAD
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
  unread: number              // count of unread messages that raise the notice
  newestId: string | null     // newest unread message id among them
  newestAt: string | null     // ISO 8601
  pollAfterSeconds: number    // the CLI waits at least this long before polling again; floor 900
}

Message {
  id: string                  // ULID: sortable, so "newer than" is a string compare
  kind: string                // any kind the web inbox carries ("mention", "issue_shipped", …); a string so new kinds still parse
  title: string               // one line, plain text, at most 120 characters
  body: string                // markdown, at most 8 KiB
  createdAt: string           // ISO 8601
  link?: string               // https URL on the Swamp Club site
  action?: { label: string, command: string }   // e.g. { "label": "Update now", "command": "swamp update" }
  readAt: string | null       // ISO 8601
}
```

`/messages` carries every message the user's web inbox does. `/summary` counts
only the kinds that should interrupt a command: announcements, direct messages,
points, system messages and issue status (`issue_shipped`, `issue_closed`,
`issue_update`). A mention, or any other kind that does not raise the notice,
leaves the ETag alone as well as `unread` and `newestId`, so it is listed
without raising the notice and never spends the client's `304`. Swamp Club
decides which kinds count; the client needs no list of its own.

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

- **Terminal escapes and invisible characters are stripped.** `kind`, `title`
  and `action` are reduced to one line with no ANSI escape sequences or control
  characters. `body` keeps newlines and tabs and loses every other control
  character. `kind`, `title`, the action's label, `body` and `link` also lose
  bidi controls (U+061C, U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069)
  and zero-width characters (U+200B to U+200D, U+2060, U+FEFF), which print
  nothing yet can reorder the text around them or hide a difference between
  two strings. The body and the title keep the zero-width non-joiner and
  joiner (U+200C, U+200D): prose needs them to join an emoji sequence and to
  spell Persian and several Indic scripts, and they cannot reorder text. The
  action's command is never stripped: a command holding any of these
  characters, anywhere in the text as sent, drops the action, since stripping
  could turn it into a command it only resembled.
- **A blank title falls back to the kind.** A title left empty by stripping, or
  holding only the zero-width joiners prose keeps, is replaced by the message's
  cleaned `kind`, as Swamp Club does for an empty title. Dropping the message
  instead would leave the summary counting one that `swamp inbox read` cannot
  show. A message whose `kind` is empty once cleaned is still dropped.
- **An action is always one allowed `swamp` command.** The command must be
  `swamp` followed by words made of letters, digits and the characters `@`, `%`,
  `+`, `,`, `.`, `/`, `:`, `=`, `_` and `-`. Quotes, `;`, `|`, `&`, `$`,
  backticks, redirects, globs and `~` are refused, so the text can never chain
  or substitute a second command after `swamp`. It must also be, word for word,
  one of the commands in `INBOX_ACTION_COMMANDS`:
  - `swamp update`
  - `swamp quest`
  - `swamp inbox`, `swamp inbox read`
  - `swamp subscription status`, `swamp subscription start`,
    `swamp subscription start --collective <slug>`
  - `swamp extension pull <@scope/name>`
  - `swamp extension search <words>` (words that never start with `-`)
  - `swamp issue get <number>`

  Any other subcommand or flag is refused, as is any word holding `://`, so a
  message can never suggest a command that points swamp at another server,
  such as `swamp auth login --club …`. The action reaches the `Next:` line and
  `action.command` in `swamp inbox read --json`, where an agent may run it.
  Swamp Club's send-time check mirrors this list. A command that breaks either
  rule, or is longer than 200 characters, drops the action; the message is
  kept. A command is never shortened, because a shortened command would not
  run.
- **A link is always `https:`, with no username or password.** Any other link is
  dropped; the message is kept.
- **The page cursor is a message id.** `nextCursor` must be a ULID or null, as
  the server builds it from the oldest listed message's id. Any other value
  refuses the page as malformed, so the older-page command swamp suggests
  never holds server text.
- **Ids are ULIDs and dates are ISO 8601.** A message that breaks either, or
  whose body is over 8 KiB, is dropped and the rest of the list is kept. The
  page reports how many it dropped, so a server that drifts from this contract
  shows up rather than losing messages silently. An over-long title, kind or
  action label is shortened, counted and cut in code points, so a character
  outside the Basic Multilingual Plane is never split into half a surrogate
  pair.
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
  the cache records why and when. The slow commands are `workflow run`,
  `behavior run` (and `model method run`), `extension pull` and
  `extension push`. The poll starts once the auth gate has passed, before the
  command's action, and runs alongside it for at most 5 seconds. At teardown,
  on success and on error alike, the CLI waits at most 250 ms more, aborts a
  poll still running (saved as a failed poll), and only then writes the
  cache, so a command that exits early loses at most one request, never a
  half-written state. A process that cannot write the cache does not poll,
  since it could not record the poll: before a poll, the CLI checks that it
  owns the config directory and creates and removes a file in the cache
  directory. A key that a later answer shows working, an `ok` or a `304` from
  the refresh that follows marking read, is no longer stopped, so one wrong
  `401` from a proxy never ends polling for good. An answer to a request sent
  before the stop was recorded leaves the stop in place: it predates whatever
  stopped the key.
-  **The cache.** The last summary and its `ETag` are cached locally, so a `304`
  costs nothing and the notice needs no network call. Each API key has its own
  file per server, `inbox-v2/<hash>.json` in the swamp config directory, named
  from a hash of the server's origin and the key's fingerprint. A personal key
  and a collective key never share or overwrite state, and neither does one key
  used against two servers (staging and production), so one server's answers
  never decide when the other is polled or what its notice says. The file holds
  neither the key nor the server's URL, is readable by its owner only (mode
  0600, as `auth.json` is), and `swamp auth logout` removes it. Each snapshot
  records when the request that fetched it was sent, and a snapshot fetched
  earlier never replaces one fetched later, so a slow poll sent before
  `swamp inbox read` marked a message read cannot bring its notice back. A
  stored time later than now (the clock went back) never blocks a new snapshot.
  At most 8 keys are kept and the least recently saved is dropped. The first
  layout, `inbox/<fingerprint>.json`, shared one file across servers; it is left
  to older swamps, and logout removes the key's file there too. Logout removes
  the file for the server the stored login names only: state the same key left
  for another server (through `SWAMP_CLUB_URL`) cannot be found from its hashed
  name, holds no secret, and goes with the 8-key cap. Upgrading to this layout
  starts every key from an empty state once: the next slow command polls, and a
  message already announced but still unread may be announced again. A file that
  is missing, corrupt or out of bounds reads as a key never polled. Changes to
  the file format are additive only, and each added field must be safe to lose,
  since an older swamp drops fields it does not know when it saves. A breaking
  change moves to a new directory, so two installed versions never share a file.
- **The notice.** After a command finishes, the CLI prints a notice when there
  are unread messages newer than the last one it announced. It goes to stderr,
  in log mode only, after the command's output:

  ```
  ℹ A new message from Swamp Club is waiting for you.
    To read it:  swamp inbox read
  ```

  With more than one unread message, the first line reads
  `ℹ 3 unread messages from Swamp Club are waiting for you.` The second line
  never changes; its `To …:` label matches `To approve:` and `To signal:` in the
  workflow renderer. The text is fixed: no message title or other server text
  appears in it. An agent that sees it then reads the message with
  `swamp inbox read` once its current task is done, and tells the user what it
  says, so Swamp Club text does reach the agent's context. Three things keep
  that text from steering the agent: the CLI strips invisible characters from
  it and prints every link as where it really leads (swamp-club#4079); a
  message's `Next:` can only be one allow-listed `swamp` command
  (swamp-club#4079, swamp-club#4086); and the `swamp` skill forbids following
  instructions in a message, or running its command, without the user's
  agreement. The notice never appears in `--json` mode, so an
  agent running commands with `--json` never sees it, and JSON output never
  carries it. The `swamp` skill quotes the second line, so the two must change
  together. A notice retires after 24 hours, whether or not the user reads the
  message, and at once if its announcement is dated after now, as when the clock
  went back. If the clock then returns past that time, the same message shows
  again for what remains of its 24 hours. A message's first showing is shown
  only once it is recorded in the cache, so a notice that could never retire, in
  a config directory this process cannot write, is never shown. Deciding it
  reads only the cache, so a fast command shows the notice a slow command's poll
  found, at the cost of one small file read and no request. It prints only after
  a command that succeeded, before the update banner; a failed command's output
  ends with its error. A run that reports its failure through the exit code, as
  a failed `workflow run` does, counts as failed. `-q` hides it as it hides the
  other post-command notices. These commands never show it: every command the
  auth gate exempts, `inbox`, `subscription`, `auth`, and the long-running
  `serve`, `worker`, `start` and `dashboard`.
- **Switching it off.** `CI` set to anything but an empty string, `0` or
  `false` turns off both the poll and the notice; nobody reads a CI log for
  them. `SWAMP_NO_INBOX_NOTICE`, read the same way as `SWAMP_NO_UPDATE_CHECK`,
  does the same anywhere. A nested run — a swamp started by another swamp, such
  as from a workflow step or a shell behavior — neither polls nor shows the
  notice, so it never prints into output its parent captures; the outermost
  run does both.
- **The commands.** The two commands have separate jobs: `swamp inbox`
  browses the inbox, and `swamp inbox read [id]` reads one message.
- **`swamp inbox` outside a terminal** (stdout or stdin not a TTY) and with
  `--json` lists messages, newest first: unread ones by default, read ones too
  with `--all`. `--limit` takes 1 to 100 (default 20, always sent, since the
  server's default is 50) and `--before <id>` lists the page older than that
  message. Each row shows the date, kind and title, with a marker on unread
  ones, and ends with the message's full id, dimmed, so a person or an agent
  can pass it to `swamp inbox read <id>`. After the count line comes
  `To read one:  swamp inbox read <id>`. `--json` prints
  `{ status, messages, nextCursor, dropped }` with the same fields, ids
  included. The body, link and action never appear, and the list never marks
  anything read. When the page has another one after it, the list ends with
  `To see older:  swamp inbox --before <id>` (repeating `--all`). Messages the
  client left out are reported on stderr in log mode.
- **The interactive inbox.** In a terminal (log mode, stdin and stdout both
  TTYs), `swamp inbox` opens an inbox that stays open until the user leaves.
  `swamp inbox read` never opens it. It loads one page with `status=all`, so
  read messages can be opened again; `--limit` and `--before` set the first
  page and `--all` changes nothing. It opens on the newest unread row, or on
  the first row when none is unread. An empty inbox opens nothing and prints
  `Your inbox is empty.` It has two views:
  - **The list.** Rows have the list's columns without the id, typing filters
    on title and kind, and the preview shows the highlighted message whole:
    kind and date, title, body, then its `Link:` and `Next:` lines. Previewing
    makes no request and marks nothing read. Every preview row is wrapped to
    the pane, so a long body link or `Link:` line shows whole rather than cut
    to its start, and the preview scrolls to its last row. Enter opens the
    highlighted message in the message view and marks it read. Ctrl-r marks
    the highlighted message read and Ctrl-a marks every unread message loaded
    so far read, including rows the filter hides; both leave the list open.
    Ctrl-u/d scroll the preview. Esc clears the filter when there is one, and
    otherwise quits. The action keys need Ctrl because plain letters type into
    the filter, and Ctrl-m is the same key as Enter.
  - **The message view.** One message, full screen, rendered as the preview
    renders it. Up/down, PgUp/PgDn and Ctrl-u/d scroll it, as far as its last
    wrapped line. Esc goes back to the list with the same row highlighted.

  The help bar shows the current view's keys:
  `↑/↓ navigate  Ctrl-u/d scroll  Enter open  Ctrl-r mark read  Ctrl-a mark all read  Esc quit`
  in the list (`Esc clear filter` while filtering, and no `Ctrl-u/d` when the
  terminal is too small for a preview), and `↑/↓ scroll  PgUp/PgDn page  Esc back`
  in the message view. Ctrl-c quits from either view. Marking read
  happens in the background: the row's marker clears at once, and the request
  goes out in order after any before it. If the request fails, or Swamp Club
  does not confirm an id, the marker comes back and the bottom line reads
  `Could not mark 1 message read: <reason>` until the next key. Typing and
  scrolling never wait on the network. When the highlight reaches the last row
  and the page has another after it, the next page loads and is appended, with
  a `loading older messages…` row meanwhile. A failed load says so on the
  bottom line and is retried by the next ↓ on the last row; a page that is
  empty or names the same cursor again ends paging. On quit the inbox waits for the
  marks still in flight, for at most 5 seconds, aborting any left and any page
  still loading, then prints one line only when something happened, from the
  counts Swamp Club confirmed: `Read 2 messages and marked 3 read.` Entries
  that older pages left out are reported on stderr after it. Nothing else is
  left in the scrollback. The inbox never runs a message's suggested command.
- **Body links show where they lead.** A message body is markdown that Swamp
  Club wrote. Rendered for the terminal, every link in it, autolinks, reference
  links and images included, prints as `text (href)`, never as a terminal
  hyperlink, which would show only the text and could disguise its target.
  Each href gets the `link` field's rules: it is parsed as a URL and printed
  in its parsed form, so a look-alike host shows as punycode
  (`https://xn--swmp-club-1yh.com/…`) and the path is encoded. An href that is
  not `https:`, carries a username or password, or does not parse prints the
  link text followed by `(link removed)`. The one exception is a bare
  `www.` or email autolink, such as `www.swamp-club.com` or
  `team@swamp-club.com` in running text: its text is its whole target, so it
  prints as written.
- **`swamp inbox read [id]`** prints one message and marks it read, the same
  in a terminal and outside one; it never opens the interactive inbox. With an
  id, it reads that message. The id is the message's full 26-character ULID,
  as `swamp inbox` prints it, in any letter case; anything else is refused
  before any request with
  `Not a message id: <value>. Message ids are the 26-character ids swamp inbox prints.`
  The message is fetched by id and printed in the form below; one that is
  unread is marked read first, and one already read is shown again with
  nothing marked. An unknown id, or someone else's, fails with
  `Message <id> not found.` and exit 1. It ends with
  `To read the next:  swamp inbox read` while other messages are unread, and
  `--json` has the same shape as below. Without an id, it prints the message
  the notice announced, or else the newest unread message (kind and date,
  title, the body as plain markdown, `Link:` and `Next:`), and marks it read.
  `/messages` lists kinds that never raise the notice, such as mentions, so its
  newest unread entry need not be the one the notice is about; reading that one
  would leave the notice up. It first asks `/api/inbox/summary`, without an
  `ETag` and bounded as the refresh after marking is, and applies the answer to
  the key's cache. When the answer names a `newestId` and that message, fetched
  by id, is still unread, it is the one shown. Any other answer, a message that
  is gone, already read or refused by the client, falls back to the newest
  unread message in the list. Repeated runs so read the notice's messages
  first, newest first, and the notice stops after the first; then the rest,
  mentions included. While more are unread it ends with
  `To read the next:  swamp inbox read`. With nothing unread it prints
  `No unread messages.` and exits 0. Unread messages are listed two at a time;
  while every entry on a page broke the contract and another page follows,
  listing goes on, at most 5 pages, unless the announced message is already in
  hand. `moreUnread` is true when the page holds an unread message other than
  the one shown, a later page or a left-out entry exists. A left-out entry is an
  unread message this swamp cannot show, so it can keep `moreUnread` true
  after the last message it can show: the next `swamp inbox read` then
  prints `No unread messages.` with the left-out warning. `--json` prints
  `{ message, moreUnread, dropped }`, with `message: null` when nothing is
  unread. The message's `readAt` is the CLI's own clock at the time it marked
  it, since `POST /api/inbox/read` returns ids only. `dropped` counts unread
  messages the client left out; the summary counts a left-out message only when
  its kind raises the notice. The message is marked before it is printed, so a
  run killed in between leaves it read but unseen, still listed by
  `swamp inbox --all` and readable with `swamp inbox read <id>`. Message body
  text reaches stdout only from `swamp inbox read` or the interactive inbox.
- **Marking read updates the cache.** Every path that marks messages read
  (Enter, Ctrl-r, Ctrl-a and `swamp inbox read`) sends only those ids. Then
  `swamp inbox read` asks `/api/inbox/summary` once, and the interactive inbox
  asks once at quit when Swamp Club confirmed any id. The call has no `ETag`,
  and its answer is applied to the key's cache for the server it asked, as a
  poll, so the notice stops at once.
  The cache is saved only when the process owns the config directory. The
  refresh is bounded by a 5-second timeout. A refresh that fails is not
  recorded, so it does not put off the next poll, and it is not an error: the
  messages are already read, and the next poll corrects the cache.
