---
audience: maintainer
last-verified: 2026-10-23 @ 9a065cc6
---

# swamp start

`swamp start` gets a new user from an installed binary to an agent working on
their own task, without knowing any swamp commands. It reaches the **Behaviors**
and **Data** primitives (a first behavior and its first run, done by the agent)
and prepares the ground for the **Serve** dashboard.

## Glossary

- **Workspace**: a swamp repo `swamp start` manages, registered in
  `<config dir>/workspaces.json` (see [workspace.md](./workspace.md), which
  also covers the `swamp workspace` commands). A new one is created, with no tools enrolled,
  at `<location>/<name>`: the folder chosen on the page or with `--path`, else
  the one set with `swamp config set workspaces.dir`, else
  `<data dir>/workspaces` (`getSwampDataDir()`, so it moves with
  `SWAMP_HOME`); an imported one is an existing repo that stays where it is. A
  user can have many; each new one gets a suggested `adjective-creature` name
  (`misty-heron`) they can change before it is created, and the page shows the
  folder it will be created in as either field changes.
- **Task**: one automation task of a workspace and its pass through the flow
  (`StartSession` in code): the text, the agent chosen for it, its launches.
  A workspace holds any number; none is "current". Each is a record at
  `<workspace>/.swamp/start/tasks/<id>.json`.
- **Brief**: the task's own file the agent reads, `tasks/<date>-<slug>.md` at
  the workspace root beside the instruction files (`briefFile`, assigned once
  when the task is first saved, `-2`, `-3`… when taken). The task goes in
  verbatim, under a first line of `<!-- swamp start brief v1 -->`
  (`BRIEF_HEADER`) that tells it apart from anyone's own file, which is never
  overwritten. Task records, the per-process server records and the launcher
  stay in `.swamp/start/`.
- **Task kind**: a plain task (the default) or `swampify` (`taskKind` on the
  record). One kind serves two texts: the build brief the
  [Swampify page](./swampify.md#the-page) hands over, and the kick-off that
  "Start from your past sessions" writes. A swampify task's brief keeps the
  task's own steps instead of start's, says the workspace is the user's own
  repo, ends its context with a link to the Swampify page when the launch
  came from a page (see [the page link](#the-swampify-page-link)), and its
  launch prompt names the `swampify` skill. An edit from the start page keeps
  the kind.
- **Signals**: whether a few local folders exist, checked when status is read
  and never read inside. `kubeconfig`, `awsConfig` and `gcloudAdc` order the
  example tasks. `claudeTranscripts` (`CLAUDE_CONFIG_DIR/projects`, else
  `~/.claude/projects`) and `codexSessions` (`CODEX_HOME/sessions`, else
  `~/.codex/sessions`), the roots `@swamp/agent-sessions` reads, offer
  "Start from your past sessions". An empty override counts as unset.
- **Harness**: an AI agent CLI, such as Claude Code or Codex.
- **Launch**: enrolling the harness, writing the brief and launcher, and opening
  the agent's terminal window.

## Flow

```
terminal:   swamp start [--workspace <name>] [--host <ip>] [--port <n>]
              ├─ sign-in check (the auth gate's own check; ungated command)
              ├─ start the server (loopback unless --host), no workspace yet
              ├─ with --workspace: open it now (claim, create if missing)
              └─ open http://127.0.0.1:<port>/dashboard/start#token=<t>
browser:    [sign in, if needed] ─▶ workspace ─▶ task ─▶ agent ─▶ trust
              ─▶ launched   (workspace: pick up, create or import one)
new window: the agent starts in the workspace and reads the brief
terminal:   swamp start stops when the page is gone (or on Ctrl-C)
```

Sign-in comes first: until the user is signed in the page shows only the
sign-in step, and the server refuses every workspace-changing operation (repo
init or upgrade, import, enrolling agents, launching).

Several `swamp start` processes may have one workspace open at once; nothing
locks it. Creating a workspace runs under `<data dir>/workspaces/<name>.lock`,
so two first runs never both initialise the folder. Each process that opens a
workspace writes `.swamp/start/servers/<pid>.json`, and removes it on leaving,
switching or exiting. The picker reads those records (pruning dead ones) to
note "Also open in another swamp start", and the trust screen warns that
launching would open a second agent window. Each server answers
`GET /start/ping`, a liveness probe another `swamp start` can use to confirm a
record's server is still running.

Opening a workspace that has tasks shows its **home**: every task, newest first
by when it was created (each row shows its created date and time, its agent and
how far it got), and the open task's summary — the newest one to begin with. The
page keeps which task is open in the server's memory; nothing on disk marks a
task as special. A launched task's summary shows the agent and when it was
launched, and how many behaviors and workflows the workspace holds; a task not
launched yet carries on from its own step. Its agent toggle picks which agent to
open, and **Launch Agent** reopens it without sending the task again: Claude
Code (`--continue`), Codex (`resume --last`, filtered to the folder) and
OpenCode (`--continue`) continue their most recent conversation in the
workspace; the others open a fresh session there. A resume that fails within
`RESUME_FALLBACK_SECONDS` (10s) opens a fresh session instead: `claude
--continue` exits 1 with "No conversation found to continue" when the folder has
no earlier conversation (a copy-command launch never run, or another home).
Codex starts a fresh session on its own. "Launch again", which re-sends the
task, appears only right after a launch in the same run.

Workspaces are registered centrally in `<config dir>/workspaces.json`
(`WorkspaceRegistry`, `src/domain/workspace/`), beside `auth.json`. The
registry, not the filesystem, says which workspaces exist and where each
folder is. New workspaces are created in their location (see the glossary) and
registered as created; an existing swamp repo anywhere on disk can be
imported, which registers it where it is without moving anything.

The create form has a Name and a Location field. Both show their default as a
placeholder and an empty field uses it; Location has a Browse button when this
machine can show a folder chooser (`start.folder.pick` with purpose
`location`). As either field changes, the page asks
`start.workspace.location.check` (reads only) and shows "Creates <folder>"
under the fields, or the problem under the field it is about. The server
works the folder out, so the page never joins paths itself, and
`start.workspace.choose` runs the same checks again on the folder it creates.
The page only sends absolute or `~` folders; the server refuses a relative
one (`parent_not_absolute`) rather than resolving it against its own working
folder. `swamp start --workspace <name> --path <dir>` does the same from the
command line, where a relative `<dir>` is taken from the current folder.

The first read adopts folders already under `<data dir>/workspaces/`;
`swamp start --json` and `swamp start status` adopt in memory only, writing
nothing. Workspace locks always live in `<data dir>/workspaces/<name>.lock`,
never beside an imported repo or a workspace created in a chosen folder.

A workspace keeps every task it has had, each with its own record and brief,
so two agents can work on two tasks in one workspace without one brief
replacing the other. Opening a task changes nothing on disk. "New task in this
workspace" writes nothing until the text is saved; Cancel goes back to the
task that was open. A task's text can change until it is launched.

Workspaces from before tasks had their own records are converted the first
time `swamp start` opens them (`migrateLegacy`): the old
`.swamp/start/state.json` and each `.swamp/start/history/<id>/state.json`
become task records, a `TASK.md` that is a swamp brief moves to the task's
`tasks/` file, and the brief a filed task recorded in `brief.json` becomes its
`briefFile`. It is idempotent and safe if two processes race; an old file that
can't be read is kept (renamed `.unreadable-<time>` where something would
otherwise replace it), never deleted, and a `TASK.md` swamp didn't write is
left alone. Until a workspace is opened, `swamp start status` reads the old
files without changing them.

A workspace can be set up for several agents, like
`swamp repo init --tool x --tool y`: the agent screen picks the one that opens
and, optionally, others to set up as well (installed or not). Launch enrols the
union of the tools the workspace already has, the chosen extras and the
harness, and never removes a tool.

Inside a workspace, any installed agent can be opened without a task, and the
workspace can be set up for more agents without starting one: the "Configured
agents" panel on the resume, launched and tasks screens. An agent that
was launched in the workspace before continues its own conversation where it
can (`--continue`, `resume --last`); one that wasn't opens a fresh session.

## Start from your past sessions

When either transcript signal is on, the workspace screen opens with a
one-line card above the workspace list and the create form: the Swampify
icon (shared with the dashboard sidebar through `components/nav_icons.tsx`),
"Find tasks to automate from your agent session history." and a
**swampify!** button. The button opens the panel, which says what will be read
(transcript text on this machine, prompts and replies included, in the chosen
window and scope; the agent asks before it reads), what the workspace stores
(counts, token costs and up to five short redacted excerpts per chore; session
records stay prompt-free) and that where the data goes is the user's choice.
It asks for a window (7, 30 or 90 days, default 30), excluded folders (scope
is every session on this machine), the agent (Claude Code or Codex, only
those whose signal is on and found on PATH) and a workspace name, prefilled
`swampify`, or `swampify-2`, `-3` when taken.

The page sends `start.swampify.kickoff` with those fields and no text. The
server checks sign-in, the window and paths and the agent first
(`startCheckSwampifyKickoff`), so a refusal creates no workspace; then it opens
or creates the workspace and saves one swampify task with its agent chosen
(`startSaveSwampifyKickoff`), landing on the trust step. Core writes the task
text (`SwampifyKickoff` in `src/domain/start/swampify_kickoff.ts`); its only
user input is the window and the excluded paths. Each path must be absolute
or start with `~`, at most 20 of 512 characters, with no quotes, backticks,
`$`, `<`, `>` or control characters, and appears only as one JSON array in a
code fence. See [swampify.md](./swampify.md#the-kick-off) for the text.

### The Swampify page link

When a swampify task is launched from a page (start's Launch, or the
Swampify page's **Swampify!** through the hub), the brief's `# Context` ends
with one line, `- Swampify page: <url>`, pinned by a test here and in the
swampify skill. The URL is `<origin>/dashboard/w/<workspace>/swampify`, where
the origin is the one the browser reached this server at: the checked
`Origin` of the page's WebSocket, else `http://<Host>`. `swampifyPageUrl`
rebuilds it from a parsed URL and gives none for anything but a bare http(s)
origin, since the brief is a file an agent reads. The line carries no token
and is left out when there is no address. It stays valid while that server
runs: a restart on another port leaves an old brief's link dead, and the next
launch writes a fresh one. The link works in a new tab because the start page
keeps its token for other tabs on the same origin, as a workspace page does
(see [Security](#security)).

The agent screen lists every harness swamp supports (the `--tool` values),
marking which are on PATH; only a found, launchable one can be chosen. It
selects the task's own agent, else the agent last picked for any task (the
registry's `lastAgent`, written when an agent is chosen), else the first that
can launch.

The header reads left to right: the wordmark, then a breadcrumb of
"All workspaces / <workspace>". Inside a workspace the wordmark and "All
workspaces" go back to the workspace list (asking first when unsaved task text
would be lost), and the workspace's name goes to its task list.
`swamp start status` prints the same checklist and every workspace's state.

Swamp hosts no model: it never interprets the task. The agent, guided by the
`swamp-getting-started` skill's brief entry point, turns the brief into a
behavior and a first run.

## Where the code lives

| Layer          | Path                                                              |
| -------------- | ----------------------------------------------------------------- |
| Domain         | `src/domain/start/` — `StartTask`, `StartSession`, harness table, brief, launcher scripts, `TerminalLauncher` port |
| Infrastructure | `start_session_file_repository.ts`, `start_server_record.ts`, `process/terminal/terminal_launcher.ts`, `process/start_instance_probe.ts` |
| Application    | `src/libswamp/start/start.ts` (exported from `libswamp/mod.ts`)   |
| Server         | `src/serve/start/start_server.ts`; shares `src/serve/dashboard_assets.ts` and `src/serve/origin.ts` with `swamp serve` |
| CLI            | `src/cli/commands/start.ts`, `src/presentation/renderers/start.ts` |
| Browser        | `packages/dashboard/src/views/start/`, mounted before `SwampProvider` |

## Security

- The server binds `127.0.0.1` on an ephemeral port unless `--host` names
  another IP address of this machine or `--port` a port. `ListenHost`
  (`src/serve/local/listen_host.ts`) takes an IP literal or `localhost`, never
  a name, so the bind, the probe and the printed URL agree.
- A non-loopback `--host` (e.g. `0.0.0.0` for a session over SSH) serves the
  page to other machines over plain HTTP: the token crosses the network in the
  clear, and anyone who can reach the address and has the link can use the
  page. Loopback stays the default, and the output warns on every run. Over SSH
  on loopback, the output names `--host 0.0.0.0`. A host firewall (the macOS
  application firewall, say) may still need to allow swamp.
- A 32-byte one-time token travels in the URL fragment, then as the
  `bearer.<token>` WebSocket subprotocol, compared in constant time and echoed
  on upgrade.
  The page keeps it in `sessionStorage` for a reload and in `localStorage`
  for other tabs on the same origin (each server's port is its own origin),
  so a link to a workspace page, such as a brief's Swampify page link, opens
  without it. A refused token is dropped from both, the `localStorage` copy
  only while it still holds that token.
- Any `Host` other than `127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>`,
  the bound address, a `--trusted-hosts` name or, on a non-loopback bind, this
  machine's own name and routable addresses gets 421 (DNS rebinding): an
  attacker's domain can never be one of those. WebSocket upgrades pass the serve
  Origin allowlist with the same trusted names.
  A single-label machine name is resolved through the client's search domain,
  so on a network whose DNS someone else controls, open the page by address.
- Each server record (`.swamp/start/servers/<pid>.json`) names the address the
  page listens on. Another `swamp start` pings it only if it is loopback or one
  of this machine's interface addresses; any other record is treated as gone,
  since one planted in an imported workspace could otherwise aim the probe
  anywhere.
- Only the `start.*` messages exist. The API key never leaves the CLI process:
  sign-in events are projected to a whitelist before they reach the browser.
- Nothing the user typed as a task reaches a shell. The launcher holds only
  fixed text and paths, single-quoted (POSIX) or double-quoted with `%` doubled
  (`cmd`). Paths are quoted because an imported workspace's folder is chosen by
  the user, not only by Swamp.
- The page URL, with the token, is passed to the OS browser opener (`open`,
  `xdg-open`, `start`), so on a shared machine it is briefly visible in the
  process list. The token only reaches a loopback server owned by the same
  process.
- Trust confirmations are recorded in `workspaces.json` (the config dir) as
  each workspace's `trustedAt`, never read from the workspace: an imported
  repo can ship any task record it likes. Launch records it; resume and
  opening an agent refuse with `trust_required` until the workspace has one
  or the request carries `trustConfirmed`.
- Writes under `.swamp/start/` and `tasks/` refuse a symlinked folder
  (`unsafe_path`); the launcher, task records and briefs are written to a
  temporary file and renamed into place. A brief path is checked against
  `^tasks/[a-z0-9][a-z0-9-]*\.md$` before it reaches a file path or a
  launch prompt, so nothing read from disk can leave `tasks/` or carry
  quoting characters.
- Under `swamp dashboard` the token reaches no `start.*` message. The one
  start action it can take is the hub's `swampify.launch` (`startLaunchTask`):
  it saves a swampify task in the repo that dashboard serves and launches it,
  through the same sign-in, PATH, brief and trust checks as Launch, and needs
  `trustConfirmed`.
- `GET /start/ping` reports liveness only; it carries no workspace or
  account data.
- Swamp passes folder trust to a harness only through a documented mechanism
  (Cursor's `--trust`, Codex's `-c projects."<ws>".trust_level`). For Claude
  Code it explains the dialog; it never edits another tool's state.

## Harnesses

The launch prompt names the task's brief:
`Read tasks/<date>-<slug>.md and use the swamp-getting-started skill.` A
swampify task names the `swampify` skill instead.

| Harness     | Binary         | Trust   | Launchable |
| ----------- | -------------- | ------- | ---------- |
| Claude Code | `claude`       | dialog  | yes        |
| Codex       | `codex`        | passed  | yes        |
| Cursor      | `cursor-agent` | passed  | yes        |
| OpenCode    | `opencode`     | unknown | yes        |
| Copilot     | `copilot`      | unknown | yes        |
| Kiro        | `kiro-cli`     | unknown | yes        |
| Pi          | `pi`           | unknown | yes        |
| Amp         | `amp`          | unknown | no         |
| Antigravity | `agy`          | unknown | no         |

Windows opens with Windows Terminal (`wt.exe`) or `cmd start`; Linux with the
first terminal found when a display is set. macOS opens the launcher with the
default application for `.command` files, normally Terminal.app. Over SSH, on
a non-loopback `--host` (the browser is on another machine, so a window here
would go unseen), or when nothing opens, the page shows a command to copy;
**Browse…** is hidden in the same cases.

## Not in phase 1

No method runs by Swamp, no credentials in the browser, no Git, no shared
datastore, no change to repo resolution or the harness allowlists. A workspace's
dashboard is the [local dashboard](./local-dashboard.md): the start server also
serves it, and "Open dashboard" leads there once a workspace is open.
