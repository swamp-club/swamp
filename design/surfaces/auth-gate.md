---
audience: everyone
last-verified: 2026-10-01 @ HEAD
---

# Auth Gate

Every swamp subcommand needs a swamp-club.com account. The gate checks this
before a command does any work. It is built to keep working when swamp-club is
down: a user who has proved who they are once keeps running.

## Rules

1. **No credential blocks.** A credential is the API key in `auth.json` (from
   `swamp auth login`) or a collective key from `--club-api-key-file`,
   `SWAMP_API_KEY_FILE` or `SWAMP_API_KEY`.
2. **A valid proof passes with no network call.** A proof is a payload signed by
   swamp-club with Ed25519. It names the key it was issued for by fingerprint
   (`fpr`), and it may expire (`exp`). `/api/whoami` returns one with every
   verified answer. The CLI caches it in `auth_verified.json`.
3. **Without a valid proof, the CLI asks swamp-club.** A verified answer passes
   and caches the new proof.
4. **A rejection always blocks.** This holds even with a valid proof.
5. **Only a swamp-club error fails open, and only for a day.** Without a valid
   proof, a 5xx from swamp-club lets the run continue as `offline` for 24 hours
   from the first one recorded. After that the gate blocks until a check
   succeeds.

The policy is a pure domain service (`src/domain/auth/auth_gate_policy.ts`).
The orchestrator does the I/O (`src/cli/auth_gate.ts`). It runs at the start
of `runInvocation` in `src/cli/mod.ts`.

## How answers are classified

`SwampClubClient.verifyIdentity` sorts each `/api/whoami` answer by who gave
it.

| Answer                                                            | Kind           | Without a valid proof | With one       |
| ----------------------------------------------------------------- | -------------- | --------------------- | -------------- |
| 200 with `authenticated: true`                                    | `verified`     | pass                  | pass           |
| 401 with `{"authenticated": false}`, a 200 with `false`           | `rejected`     | block                 | block          |
| 403 with swamp-club's `{"error": …}` body                         | `rejected`     | block                 | block          |
| 5xx                                                               | `server_error` | pass for 24 hours     | pass (offline) |
| 429, any other 401 or 403, other non-2xx, a 200 that is not JSON  | `refused`      | block                 | pass (offline) |
| timeout, DNS or connection failure                                | `unreachable`  | block                 | pass (offline) |

A rejection must come from swamp-club itself. A gateway or proxy can send its
own 401 or 403 while the key is fine, so those count as `refused`. Without a
proof, `refused` and `unreachable` block because a client can cause them on
purpose. Blocking swamp-club.com or tripping its rate limit must never stand in
for verification.

## When the gate runs

- **Exempt**: bare `swamp`, the bare `auth` group, and `auth login`,
  `auth logout` and `auth whoami`. These are the path to a credential.
- **Deferred**: a run with `--help`, `-h`, `--version` or `-V` on the line.
  Cliffy answers those flags while parsing and exits before any action. The
  gate runs from the global action instead, so it is skipped exactly when
  Cliffy showed help. A token that was really an option's value, as in
  `--input --help`, still reaches the gate.
- **At startup**: everything else, including `help`, `version`, `update`,
  `completions`, `serve` and `worker`. The gate runs right after telemetry
  starts, before the repo marker, extension loaders or auto-resolver.

`src/cli/auth_gate_exemptions.ts` holds the rule.

A blocked run throws `AuthGateBlockedError` (code `auth_gate_blocked`). It
records one telemetry event with `authMode: none` and exits 1. In hook mode
(`audit record --from-hook`) the gate checks locally only. A blocked hook
records nothing and exits 0, so an agent session is not broken.

## CI and signin tokens

An ephemeral runner keeps no `auth_verified.json`. It sets two secrets from the
collective token page on swamp-club.com:

- `SWAMP_API_KEY`: the credential.
- `SWAMP_SIGNIN_TOKEN`: a proof for that key, encoded as
  `<base64url proof>.<signature>`. It has no expiry.

The token carries no public key. It is verified against keys cached by an
earlier whoami, then against the production key built into the binary
(`src/domain/auth/embedded_public_key.ts`).

An environment variable cannot be deleted when a key is revoked. So a valid
signin token is checked live before the command, with a 3-second timeout, at
most once an hour per key (`auth_token_check.json`). A rejection blocks. Any
other failure runs on the token as `offline`.

When both a signin token and a file proof exist, the gate uses whichever was
issued for the active key. A stale exported token never hides a valid login.

## Weekly refresh

A file proof older than seven days is refreshed after the command finishes.
The refresh uses a 3-second timeout and is awaited before exit. It never
changes the current run. A verified answer saves the new proof. A rejection
deletes it, so the next command blocks. Any failure keeps it for the next run.
Proofs expire after 14 days, which leaves a week of margin if swamp-club is
down when a refresh is due.

## State in the config dir

| File                    | Holds                                               | Cleared by                    |
| ----------------------- | --------------------------------------------------- | ----------------------------- |
| `auth_verified.json`    | The proof and the public keys from the last whoami  | a rejection, `auth logout`    |
| `auth_fail_open.json`   | When the current 24-hour fail-open window started  | a verified answer, logout     |
| `auth_token_check.json` | The fingerprint and time of the last token check   | a rejection, logout           |

All three are written mode 0600. Writes are best effort: a read-only config dir
never fails a run the gate already passed. A future or unparsable time is read
as absent, so editing a file cannot widen a window.

`swamp serve daemon enable` and `swamp worker daemon enable` set
`SWAMP_CONFIG_DIR` in the service definition, so a system-mode daemon reads the
enabling user's credential and proof. A worker daemon enabled before this
change lacks it and must be enabled again.

## Telemetry

`invocationContext.authMode` records how a run got through:

- `verified`: a valid proof, or a verified answer this run.
- `offline`: swamp-club could not be checked, and a proof or the fail-open
  window carried the run.
- `none`: exempt or blocked.

## Key rotation

Planned rotation keeps the old key in the whoami response for 30 days. Cached
proofs keep verifying, and every refresh caches the new key. The embedded key
must be updated in a release inside that window. On an emergency rotation,
every proof signed with the old key stops verifying at once. Interactive users
re-verify on their next run. CI tokens need new tokens and a release that
carries the new key.

## Non-goals

- **Tamper resistance.** Public keys cached in `auth_verified.json` are taken
  from whoami and stored in a file the user can write. So are the token-check
  and fail-open stamps. A local user can forge them, just as they can patch the
  source. The gate enforces an account requirement. It is not a security
  boundary.
- **Re-checking long-running processes.** `serve` and `worker` pass the gate
  when they start and are checked again when they restart. A revoked collective
  key still fails their own swamp-club calls, such as heartbeat and
  registration.

## Why

An opaque API key can be revoked instantly by deleting it on swamp-club. A
signed proof lets the CLI check that key without a network call, so normal runs
pay no latency and an outage does not stop users who have verified. A live
rejection still always wins.
