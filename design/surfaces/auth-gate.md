---
audience: everyone
last-verified: 2026-10-01 @ HEAD
---

# Auth Gate

Every swamp subcommand needs a swamp-club.com account. The gate checks this
before a command does any work. It is built to keep working when swamp-club is
down: a user who has proved who they are once keeps running.

## Rules

1. **No credential blocks, except in a nested run.** A credential is the API
   key in `auth.json` (from `swamp auth login`) or a collective key from
   `--club-api-key-file`, `SWAMP_API_KEY_FILE` or `SWAMP_API_KEY`. A swamp
   started by another swamp that passed may pass on its pass instead (rule 6).
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
6. **A nested run inherits its ancestor's pass.** Without a credential of its
   own, a swamp passes when it holds a pass whose proof swamp-club signed, was
   still valid when its issuer started, and whose issuer is a live ancestor
   running the same executable. See [Nested runs](#nested-runs).

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
| 5xx                                                               | `server_error` | pass for 24 hours     | pass (offline) |
| 429, any 403, any other 401 or non-2xx, a 200 that is not whoami  | `refused`      | block                 | pass (offline) |
| timeout, DNS or connection failure                                | `unreachable`  | block                 | pass (offline) |

A rejection must come from swamp-club itself, because a rejection deletes the
cached proof. swamp-club's whoami answers an unknown key with exactly
`401 {"authenticated": false}` and never sends a 403. A gateway or proxy can
send its own 401 or 403, often with a JSON `error` body, while the key is
fine. So any other 401 and every 403 count as `refused`. Without a
proof, `refused` and `unreachable` block because a client can cause them on
purpose. Blocking swamp-club.com or tripping its rate limit must never stand in
for verification.

## When the gate runs

- **Exempt**: bare `swamp`, the bare `auth` group, and `auth login`,
  `auth logout` and `auth whoami`. These are the path to a credential. Also
  exempt is any line Cliffy will answer with help or version output
  (`--help`, `-h`, `--version`, `-V`), because no command runs. Four commands
  that touch no swamp feature are exempt with their subcommands:
  - `help`: the structured `--help` agents read to learn the CLI.
  - `completions`: shell rc files run it at every shell start.
  - `version`: it matches `--version`.
  - `update`: a blocked user, or a CI host after a signing-key rotation, must
    be able to install the release that fixes it.
- **Gated**: everything else, including `serve`, `worker`, `init` and
  `doctor`. The gate runs right after telemetry starts, before the repo
  marker, extension loaders or auto-resolver.

The decision is made against the real command tree, the same declarations
Cliffy parses (`createRootCommand` and `registerCommands` in
`src/cli/mod.ts`). Guessing from token positions once read `swamp --log init`
as bare `swamp`, because the guess did not know `--log` takes no value, and let
`init` run without an account. A help or version token counts only when no
command on the path declares that name, and the token before it is not an
option that takes a value. So `--input --help` is still gated. When in doubt
the rule gates. `src/cli/auth_gate_exemptions.ts` holds it.

A blocked run throws `AuthGateBlockedError` (code `auth_gate_blocked`). It
records one telemetry event with `authMode: none`. In JSON mode the error
carries `reason` (`kind`, plus `status`, `retryAfterSeconds` or
`daysSinceVerification` where they apply) and `temporary`. A temporary block
(refused, unreachable, or swamp-club failing for a day) exits 75
(`EX_TEMPFAIL`), like a lock timeout, so CI can retry it. A missing or revoked
credential exits 1. An error the gate itself hits, such as an unreadable
`auth.json`, is reported as itself and recorded the same way. In hook mode
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

An ephemeral runner keeps no `auth_fail_open.json`. A CI job without a signin
token therefore starts a fresh 24-hour window on every job while swamp-club
returns 5xx. Only swamp-club can produce a 5xx, so a client cannot trigger
this. CI should set the signin token.

## Nested runs

A workflow shell step that runs `swamp` starts a nested swamp. Method children
inherit no `SWAMP_*` credential (swamp-club#2032,
[remote execution](../enablers/remote-execution.md)), so in CI, where the key
lives only in the environment, the nested swamp has no credential. Instead it
inherits a pass.

Every gated run that passes sets `SWAMP_NESTED_GATE_PASS` in its own
environment to `<pid>.<base64url proof>.<signature>`: a pid and a proof. A run
admitted on its own key hands down its own pid with the fresh proof a verified
whoami returned, else the valid proof cached in `auth_verified.json`. A run
admitted on an inherited pass hands that pass on unchanged, so it still names
the swamp first admitted on the proof, and a daemon's grandchildren are judged
against the daemon's start rather than the nested run in between.

The proof is never the `SWAMP_SIGNIN_TOKEN` one: the token is a CI secret, and
handing its contents down under another name would undo the stripping. In CI
the first gated run of a job checks its token live and caches the fresh proof,
so later runs have a file proof to hand down. A run with no such proof (one
that passed offline on its signin token alone, or offline and fail-open)
clears any pass it inherited and hands nothing down. The shell model lets this
one variable through to its children, next to `SWAMP_LOCK_HOLDER_PID`. The
value is fixed for the life of the process, because the gate runs once.

A swamp with no credential accepts the pass when all three checks hold:

- **swamp-club signed the proof.** The signature is checked against the keys
  cached in `auth_verified.json`, then the embedded key, never a key the pass
  supplies. The fingerprint is not checked, since the nested run has no key to
  match.
- **The issuer is a live ancestor running this executable.** The gate walks
  the live parent chain upward from its own process, reading `/proc` on Linux
  and libproc on macOS (both through libc over FFI, because Deno reads
  `/proc/<pid>` only with `--allow-all`). The issuer's executable must resolve
  to the same file. On Linux, a binary replaced in place by `swamp update`
  still matches by its install path. Windows and musl are not supported, so the
  check fails there.
- **The proof was valid when the issuer started.** It must have an `exp`, and
  that `exp` must be later than the issuer's start time, read from the OS
  alongside its executable. A long-running `serve` or `worker` keeps running on
  the proof it started with, which expires after 14 days, so its children keep
  passing too. A proof that had expired before the issuer started admits
  nothing, so a leaked or old proof is useless under any process started after
  its expiry. A proof without an `exp` (a signin token) never qualifies.

A pass that fails any check blocks with `no_credential`, the same as having
no pass. A swamp that has its own credential ignores any pass it inherits and
follows rules 1 to 5, live checks and revocation included.

A nested run has no API key, so nested commands that call swamp-club, such as
`extension push`, `issue` or `auth whoami`, fail as they did before the gate.
Run them as their own step, or as the outer command. A swamp at another path
than its parent (another installed version, or a parent run with
`deno run dev`) fails the ancestry check unless it has its own credential.
Revocation is inherited: a key revoked while a long-running parent runs keeps
its children passing until the parent exits. The issuer must stay alive: a
nested swamp that outlives it (a backgrounded `serve` started from a shell
step, say) can no longer hand its pass on. A nested run verifies the proof
against the keys cached in its own config dir, because `SWAMP_CONFIG_DIR`,
`SWAMP_HOME` and `SWAMP_CLUB_URL` are stripped too. Under a parent configured
through them, after a signing-key rotation or against a non-production
swamp-club, it may find no key for the proof and block. On macOS a binary
replaced in place may no longer match its running ancestor.

## Weekly refresh

A file proof older than seven days is refreshed after the command finishes.
The refresh uses a 3-second timeout and is awaited before exit. At most one
attempt is made an hour (`auth_refresh_attempt.json`), so an offline user does
not wait at every exit. It never
changes the current run. A verified answer saves the new proof. A rejection
deletes it, so the next command blocks. Any failure keeps it for the next run.
Proofs expire after 14 days, which leaves a week of margin if swamp-club is
down when a refresh is due.

## State in the config dir

| File                        | Holds                                              | Cleared by                 |
| --------------------------- | -------------------------------------------------- | -------------------------- |
| `auth_verified.json`        | The proof and the public keys from the last whoami | a rejection, `auth logout` |
| `auth_fail_open.json`       | When the current 24-hour fail-open window started  | a verified answer, logout  |
| `auth_token_check.json`     | The fingerprint and time of the last token check   | a rejection, logout        |
| `auth_refresh_attempt.json` | When the weekly refresh was last attempted         | logout                     |

All four are written mode 0600, and a write creates the config dir if it is
missing. Writes are best effort: a read-only config dir never fails a run the
gate already passed. A future or unparsable time is read as absent, so editing
a file cannot widen a window. On a config dir that cannot be written, the
fail-open window cannot be recorded. Each run then starts a fresh 24 hours
while swamp-club returns 5xx, the same trade-off as an ephemeral CI runner.

`swamp serve daemon enable` and `swamp worker daemon enable` set
`SWAMP_CONFIG_DIR` in the service definition, so a system-mode daemon reads the
enabling user's credential and proof. A worker daemon enabled before this
change lacks it and must be enabled again. A process that does not own the
config dir, such as a system daemon running as root, reads it but never writes
to it and skips the weekly refresh. It would otherwise leave root-owned files
that the user's own runs cannot read.

## Telemetry

`invocationContext.authMode` records how a run got through:

- `verified`: a valid proof, a verified answer this run, or a nested pass.
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
  source. A nested pass is no stronger: it needs a proof swamp-club issued, an
  ancestor started before that proof expired, and a swamp ancestor, which a
  gate-exempt command can be made to provide. Under `deno run dev` any `deno`
  ancestor counts as the same executable. The gate enforces an account
  requirement. It is not a security boundary.
- **Re-checking long-running processes.** `serve` and `worker` pass the gate
  when they start and are checked again when they restart. A revoked collective
  key still fails their own swamp-club calls, such as heartbeat and
  registration.

## Why

An opaque API key can be revoked instantly by deleting it on swamp-club. A
signed proof lets the CLI check that key without a network call, so normal runs
pay no latency and an outage does not stop users who have verified. A live
rejection still always wins.
