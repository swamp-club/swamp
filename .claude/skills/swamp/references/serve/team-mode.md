# Team Mode

A team writes one v3 datastore through `swamp serve`. Serve holds the storage
credentials; each member's checkout holds a serve address and a token. Call the
setup **team mode** in anything written for users.

## Contents

- [Set up serve](#set-up-serve)
- [Upgrade serve](#upgrade-serve)
- [Set up a member's checkout](#set-up-a-members-checkout)
- [Tokens](#tokens)
- [What runs where](#what-runs-where)
- [Who a run names](#who-a-run-names)
- [Leases](#leases)
- [Approvals, signals and cancel](#approvals-signals-and-cancel)
- [Known costs and limits](#known-costs-and-limits)

## Set up serve

1. Keep definitions in the datastore. Team mode requires `managedConfig`:
   without it, a workflow run a member drives from their checkout is refused
   when its behaviors exist only there ("a step output names data of a behavior
   that does not exist"). Serve warns at start when it is missing, on every v3
   serve; one that no member writes through can ignore the warning.

   ```bash
   swamp datastore config migrate   # sets managedConfig: true in .swamp.yaml
   ```

2. Make serve the datastore's owner, with serve stopped, so checkouts holding
   storage credentials can no longer write it directly:

   ```bash
   swamp datastore claim --address https://swamp.example.com
   ```

3. Start serve. Several nodes can share the datastore: the node holding the
   writer lease leads, and the others follow and forward writes to it. Give each
   node its own address, and a CA file when the leader's certificate is from a
   private CA:

   ```bash
   swamp serve --advertise-address https://node-a.internal:8443 --ca-cert certs/team-ca.pem
   ```

## Upgrade serve

Serve refuses a new run record that does not name the principal of the token
that sent it. Members' older CLIs name their swamp-club username, so:

1. **Flush queued offline work first.** Have each member run a writing command
   while the old serve is still up. A run record an older CLI queued offline is
   refused after the upgrade with `run_initiator_mismatch`: it stays in the
   member's outbox, `swamp datastore status` lists it as refused for its
   initiator, and the work has to be run again. There is no way to accept it as
   it is.
2. **Upgrade followers before the leader.** A follower still on the old version
   does not tell members that the leader checks initiators, so their runs are
   refused at the leader.
3. **Then have members upgrade their CLI.** An older CLI's runs are refused with
   advice to upgrade. A checkout an upgraded CLI has not yet used against the
   upgraded serve refuses to start an offline `workflow run`
   (`datastore_v3_offline_principal_unknown`) until it reaches serve once.

An upgraded CLI writes a newer checkout state and outbox, so a member cannot go
back to an older CLI in the same checkout.

## Set up a member's checkout

- `.swamp.yaml` names the datastore with `format: 3` (a clone carries it) and
  `serverAddress: <serve URL>`.
- Log in once: `swamp auth server-login --server <serve URL>`. The checkout
  needs no storage credentials.
- When serve is unreachable, the checkout works offline from its copy. The saved
  work is sent by the next command that writes to the datastore once serve is
  reachable; a command that only reads does not send it. A method that changes
  things runs offline only under a lease taken while online: see the "Team Mode:
  Leases at Serve" section of
  [concurrency.md](../behavior/references/concurrency.md).

## Tokens

`swamp access token mint`, `rotate` and `reveal` run on serve from a member's
checkout (or with `--server`), and need `admin` on `access:*`. Reveal is
answered by the leader and audited. A login token (one an OAuth or device login
minted, named `oauth-…`) is not revealable, even by an admin
(`token_not_revealable`); revoke it instead.

## What runs where

| In a member's checkout, without `--server`                       | Runs     |
| ---------------------------------------------------------------- | -------- |
| `behavior run`, `workflow run`, data and vault commands          | Locally  |
| `extension install` / `pull` (only `--server` installs on serve) | Locally  |
| `workflow approve`, `reject`, `signal`, `waits`                  | On serve |
| `workflow cancel` of a run this checkout did not start           | On serve |
| `access token mint`, `rotate`, `reveal`                          | On serve |
| Anything with `--server`, a trigger or a schedule                | On serve |

Local runs write through serve: every commit is authorised against the member's
grants and stamped with who wrote it.

## Who a run names

A run's `initiatedBy` is the principal of the member's token (for example
`user:m1`), as serve stamps it on the run's commits, never a display name. A
child run keeps its parent's initiator, including one a resume starts. A
behavior's output provenance and the `initiatedBy` data tag are the member's own
report and are not checked.

## Leases

A refusal because another caller holds a behavior's lease names the holder's
principal, whether it is an explicit lease, and when it ends;
`swamp datastore lock status` shows the same. When an explicit lease outlasts
the wait (`SWAMP_LOCK_TIMEOUT_MS`, 60 s by default), the refusal comes at once
(exit 75) instead of after the wait; a run's renewing lease is still waited for.

## Approvals, signals and cancel

- **Approve and reject** are decided on serve, under the decider's grant.
- **Signal waits:** a workflow with a `wait_for_signal` step is refused in a
  member's checkout before it starts, because serve can deliver a signal only to
  a wait it registered. Run it with `--server`, or from a trigger or schedule.
- **Gates that must bind the runner:** a member who drives a run locally owns
  the process and could skip a gate with a patched CLI. Serve stops that forgery
  from reaching anything outside their own run, but cannot stop the run itself.
  When a gate must bind whoever runs the workflow, run it on serve (`--server`,
  a trigger or a schedule): on runs serve drives, gates bind.

## Known costs and limits

- **A step's start commits before the step runs,** so a killed run never loses
  it. Each start is a small record of its own (about 1.5 KiB: job, step and
  start time), not the run record again. A start that cannot commit after its
  retries puts the step back to pending and fails the run with
  `datastore_v3_commit_unreachable` (exit 75); resume or recover it. A member
  whose serve predates step starts commits each start as the whole run record.
- **Cancel stops only this checkout's processes.** Two checkouts sharing a
  filesystem datastore no longer stop each other's runs; cancel a run from the
  checkout that started it, or through serve.
- **A member cannot change a behavior's type through an edit:** serve refuses an
  edit or rename that changes a stored definition's type.
- **A gate's freeze holds within one wait, not across a retry.** What a waiting
  gate shows its approver cannot change while the wait is open; a retry opens a
  new wait, which shows what the member's run record says then.
