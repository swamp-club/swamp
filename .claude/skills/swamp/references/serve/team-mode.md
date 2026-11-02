# Team Mode

A team writes one v3 datastore through `swamp serve`. Serve holds the storage
credentials; each member's checkout holds a serve address and a token. Call the
setup **team mode** in anything written for users.

## Contents

- [Set up serve](#set-up-serve)
- [Set up a member's checkout](#set-up-a-members-checkout)
- [What runs where](#what-runs-where)
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

## Set up a member's checkout

- `.swamp.yaml` names the datastore with `format: 3` (a clone carries it) and
  `serverAddress: <serve URL>`.
- Log in once: `swamp auth server-login --server <serve URL>`. The checkout
  needs no storage credentials.
- When serve is unreachable, the checkout works offline from its copy and sends
  saved work on the next command that reaches serve. A method that changes
  things runs offline only under a lease taken while online: see the "Team Mode:
  Leases at Serve" section of
  [concurrency.md](../behavior/references/concurrency.md).

## What runs where

| In a member's checkout, without `--server`                       | Runs     |
| ---------------------------------------------------------------- | -------- |
| `behavior run`, `workflow run`, data and vault commands          | Locally  |
| `extension install` / `pull` (only `--server` installs on serve) | Locally  |
| `workflow approve`, `reject`, `signal`, `waits`                  | On serve |
| `workflow cancel` of a run this checkout did not start           | On serve |
| Anything with `--server`, a trigger or a schedule                | On serve |

Local runs write through serve: every commit is authorised against the member's
grants and stamped with who wrote it.

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
  it. Each start costs about 12-13 ms on an 11-step run and stores the run
  record again. A 1,000-step run stores gigabytes of superseded records until
  retention sweeps them, and on a bucket each start can then cost over 100 ms
  more. This holds until a constant-size start marker ships.
- **Cancel stops only this checkout's processes.** Two checkouts sharing a
  filesystem datastore no longer stop each other's runs; cancel a run from the
  checkout that started it, or through serve.
- **A member cannot change a behavior's type through an edit:** serve refuses an
  edit or rename that changes a stored definition's type.
- **A gate's freeze holds within one wait, not across a retry.** What a waiting
  gate shows its approver cannot change while the wait is open; a retry opens a
  new wait, which shows what the member's run record says then.
