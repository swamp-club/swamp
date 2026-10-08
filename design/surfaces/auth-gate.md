---
audience: everyone
last-verified: 2026-10-08 @ HEAD
---

# Auth Gate

Every swamp subcommand needs a swamp-club.com account. The gate checks this
before a command does any work. It is built to keep working when swamp-club is
down: a user who has proved who they are once keeps running.

## Rules

1. **No credential blocks, except in a nested run or an enrolled worker.** A
   credential is the API key in `auth.json` (from `swamp auth login`) or a
   collective key from `--club-api-key-file`, `SWAMP_API_KEY_FILE` or
   `SWAMP_API_KEY`. A swamp started by another swamp that passed may pass on
   its pass instead (rule 6), and a worker on the pass of the serve that
   enrolls it (rule 7).
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
7. **A worker inherits the pass of the serve that enrolls it.** Without a
   credential of its own, `worker connect` passes when the serve that enrolls
   it sends a pass whose proof swamp-club signed and that had not expired when
   the worker reached the gate. See [Remote workers](#remote-workers).

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
  marker, extension loaders or auto-resolver. For `worker connect` alone, a
  `no_credential` block waits for enrollment (rule 7); every other block
  stands.

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

A run that passes as `offline` warns why. In log mode the warning goes through
the logger. JSON mode has no console log output, and a failing command's
stderr must stay one JSON document, so the warning is held until the run ends.
A run that writes a JSON error document carries it there as `warning` and
`authMode: "offline"` fields. Any other run, including one that reports failure
on stdout and exits non-zero, writes one line to stderr when the process exits,
`{"warning": "<message>", "authMode": "offline"}`. That line comes after any
other stderr output, and a long-running `serve` or `worker connect` writes it
at shutdown. Stdout carries only the command's own
output.

### Troubleshooting an empty audit trail

A blocked hook is silent by design, so an audit timeline that stops filling
usually means the gate blocks the hook: no credential, or no locally valid
proof (hook mode never calls swamp-club). Run any swamp command, or
`swamp auth whoami`, in the same environment to see the block message. A
signed-in user's next ordinary command refreshes the proof, and the hook
records again.

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

## Remote workers

A worker enrolls with a serve that has already passed the gate, and it runs
only the work that serve hands it (see
[remote execution](../enablers/remote-execution.md)). It needs no key of its
own. For `worker connect`, a `no_credential` block (no credential and no
valid nested pass) does not end the run. The command starts, connects and
enrolls, and the serve's pass decides at enrollment, before the worker takes
any work. Any other block, such as a rejected key or swamp-club failing for a
day, still ends the run before the command starts. A worker with its own
credential follows rules 1 to 5 and ignores the serve's pass.

The serve sends `gatePass` in its `enrolled` reply: the proof its own pass
rests on, the same one it hands its nested runs, encoded as
`<base64url proof>.<signature>` with no pid. A serve that passed without such
a proof (offline on its signin token alone, or fail-open) has none. A worker
without a credential sets `needsGatePass` in its `enroll` request. A serve with
no pass then refuses with `gate_pass_unavailable` before it redeems the token,
so the worker uses up no enrollment.

The worker accepts the pass when both checks hold:

- **swamp-club signed the proof.** The check is the nested pass's check:
  against the keys cached in the worker's `auth_verified.json`, then the
  embedded key. A key the pass supplies is never used.
- **The proof had an `exp` later than when the worker reached the gate.** A
  proof without one (a signin token) never qualifies.

The serve admitting the worker, which redeemed its enrollment token and, on an
authenticated serve, checked its server token, takes the place of the nested
pass's ancestry check. A worker that fails either check exits with
`auth_gate_blocked` and reason `no_credential`, and the message says why. It
takes no dispatch. A dispatch that arrives between enrollment and the check
waits for it. A worker that passes is recorded as `verified`. It publishes
`SWAMP_NESTED_GATE_PASS` under its own pid, so the `worker exec-dispatch`
runners it starts, and any `swamp` their shell steps run, pass as nested runs.
The check runs once per process: a reconnect does not repeat it, just as a
serve and a worker are not re-gated while they run.

A serve passes on a proof that expires 14 days after it was issued. Its weekly
refresh would otherwise run only at exit. So a serve that passed on its own
credential checks once an hour whether its pass is older than seven days. If
it is, the serve calls `/api/whoami` with the 3-second refresh timeout, at most
once an hour. It holds the fresh proof in memory and hands that out, so a
system daemon that cannot write its config dir keeps vouching too. It saves the
proof only when it owns the config dir. A rejection drops the pass, and from
then on the serve refuses workers that need one. Its own nested runs keep
the pass it started with. A serve admitted on an inherited nested pass has no
key to refresh with and hands that pass on.

Every enrolled worker receives the serve key holder's proof payload (`sub`,
`org`, `scopes`, `fpr`). That is what a nested child receives too. It carries
no key and is not a credential.

A worker without a key cannot run commands that call swamp-club itself, such
as `extension push` or `issue`, the same trade-off as a nested run. An older
serve sends no pass, so a worker without a credential is blocked there and
should be given a key, or the serve upgraded.

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
while swamp-club returns 5xx, the same trade-off as an ephemeral CI runner, and
the warning says the window cannot be recorded rather than promising a
24-hour limit.

Blocking instead (failing closed when the window cannot be recorded) was
considered and declined (swamp-club#2916). It would not close the gap: the
stamp is a user-writable file (see Non-goals), and an ephemeral CI runner
already restarts the window on every job. Only swamp-club can produce a 5xx,
so no client can provoke the case, and blocking would stop legitimate daemons
and read-only containers during swamp-club's own outage.

`swamp serve daemon enable` and `swamp worker daemon enable` set
`SWAMP_CONFIG_DIR` in the service definition, so a system-mode daemon reads the
enabling user's credential and proof. A worker daemon enabled before this
change lacks it and must be enabled again. A process that does not own the
config dir, such as a system daemon running as root, reads it but never writes
to it and skips the weekly refresh. It would otherwise leave root-owned files
that the user's own runs cannot read. The same rule covers the other writes
every run can make: such a process does not save the scope or identity cache,
does not create `identity.json`, and does not update the autoupdate
preferences.

## Telemetry

`invocationContext.authMode` records how a run got through:

- `verified`: a valid proof, a verified answer this run, or a nested pass.
- `offline`: swamp-club could not be checked, and a proof or the fail-open
  window carried the run.
- `none`: exempt or blocked.

## Key rotation

A proof is verified against the keys cached with it in `auth_verified.json`,
and only when none matches its `kid`, against the key built into the binary
(`src/domain/auth/embedded_public_key.ts`). A signin token carries no key, so
on a fresh runner it depends on the embedded key. A cached file proof keeps
verifying with its own copy of the old key until it expires (14 days) or the
weekly refresh replaces it; a release cannot shorten that, which is
acceptable because the gate is not a security boundary (see Non-goals).

Planned rotation, in order:

1. swamp-club starts signing with the new key and returns both keys in
   whoami's `publicKeys`, the old one for 30 days. Every verified answer and
   weekly refresh caches a proof signed with the new key.
2. Replace `EMBEDDED_PUBLIC_KEY` with the new key (and its `kid` in the
   comment) and ship a release inside the 30 days.
3. Collectives issue new signin tokens and update their CI secrets. A token
   signed with the old key does not verify against the new embedded key, so
   CI on the new release without a new token falls back to a live check.
4. After the 30 days swamp-club drops the old key from whoami.

Emergency rotation (the old key is compromised):

1. swamp-club drops the old key from whoami and signs with the new key.
   Users re-verify when their cached proof expires or is refreshed.
2. Replace `EMBEDDED_PUBLIC_KEY` and ship a release as soon as possible.
3. Collectives issue new signin tokens. Until a CI job has both the new token
   and the new release, it verifies live on every run and blocks when
   swamp-club cannot be reached.

## Non-goals

- **Tamper resistance.** Public keys cached in `auth_verified.json` are taken
  from whoami and stored in a file the user can write. So are the token-check
  and fail-open stamps. A local user can forge them, just as they can patch the
  source. A nested pass is no stronger: it needs a proof swamp-club issued, an
  ancestor started before that proof expired, and a swamp ancestor, which a
  gate-exempt command can be made to provide. Under `deno run dev` any `deno`
  ancestor counts as the same executable. A worker's pass is weaker still: a
  worker trusts whatever its orchestrator sends, so a fake orchestrator could
  hand it any unexpired proof swamp-club signed. That worker already runs
  whatever code its orchestrator ships. The gate enforces an account
  requirement. It is not a security boundary.
- **Re-checking long-running processes.** `serve` and `worker` pass the gate
  when they start (a worker without a credential at its first enrollment) and
  are checked again when they restart. The serve's hourly pass check keeps
  the pass it hands workers fresh. It never re-gates the serve. A revoked collective
  key still fails their own swamp-club calls, such as heartbeat and
  registration.

## Why

An opaque API key can be revoked instantly by deleting it on swamp-club. A
signed proof lets the CLI check that key without a network call, so normal runs
pay no latency and an outage does not stop users who have verified. A live
rejection still always wins.
