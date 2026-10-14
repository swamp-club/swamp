---
audience: maintainer
last-verified: 2026-10-14 @ 3999f85e
---

# Workspaces

A **workspace** is a swamp repo that Swamp keeps track of. The workspace
registry, `<config dir>/workspaces.json`, lists every workspace on the machine
by name and folder. A workspace is still an ordinary repo, so every other
command works in it unchanged.

There are two kinds:

- **Created** workspaces are made by `swamp workspace create` or
  `swamp start`, with no agent set up, at `<location>/<name>`. The location is
  the folder chosen with `--path` (or on the start page), else the one set
  with `swamp config set workspaces.dir`, else `<data dir>/workspaces`.
- **Imported** workspaces are existing repos registered where they are, by
  `swamp workspace import` or the import form on the `swamp start` page.
  Nothing is moved or copied.

`swamp start` uses workspaces for its tasks and launches; see
[start.md](./start.md).

## Commands

| Command                             | What it does                                                   |
| ----------------------------------- | -------------------------------------------------------------- |
| `workspace create <name> [--path]`  | Creates and registers a workspace in its location              |
| `workspace import <path> [--name]`  | Registers an existing repo where it is                         |
| `workspace list`                    | Lists every registered workspace, flagging gone folders        |
| `workspace get <name>`              | Shows one workspace: folder, trust, agents, open in start      |
| `workspace remove <name>`           | Takes the workspace off the registry and keeps its folder      |

`list` and `get` write nothing. Names follow `parseWorkspaceName`: one path
segment of lowercase letters, digits and dashes, at most 63 characters.

## The registry

`WorkspaceRegistry` holds the entries: name, folder, `createdAt`, `origin`
(`created` or `imported`), and `trustedAt` once the user confirmed that agents
may work there. `origin` says whether Swamp made the folder, which the launch
brief and the `imported` flag of `list`, `get` and the start page report.
Entries written before it was recorded have none and are told apart by
location: only created workspaces were under the data dir. It was added
without a schema bump so older Swamp versions still read the file; an older
version that rewrites the file drops it, and the entry falls back to the
location rule. Importing a folder under the data dir's own folder (one
`remove` left behind) records it as created. Names are
unique and so are folders. Trust lives only in the registry, never in the
workspace, because an imported repo can carry any files it likes. The file is
schema-versioned, written atomically with mode 0600 under
`workspaces.json.lock`, and never rewritten when it can't be read.

Before the registry existed, `swamp start` only created folders under the data
dir. The first read of a registry that doesn't exist yet adopts every repo
found there. A read-only command reports what it would adopt and writes
nothing. A command that writes adopts first, so a workspace it removes is not
adopted back later.

## Creating

The location is worked out once (`newWorkspaceLocation`): `~` is expanded, a
relative `--path` is taken from the current folder, and the folder must
already exist (`parent_not_found`, `parent_not_a_folder`); Swamp only ever
makes the workspace folder itself. A chosen or configured folder is used by
its real path, so one folder is never registered under two spellings; naming
the data dir's own folder is the same as the default. A folder inside another
repo is allowed and makes a nested repo.

`create` takes the workspace's create lock, `<data dir>/workspaces/<name>.lock`,
the same lock `swamp start` takes, wherever the folder goes. The checks below
(`checkNewWorkspaceFolder`) are shared by `create`, `swamp start` and the start
page's preview. It refuses:

- a name that is registered (`name_taken`)
- a folder that is registered under another name, or a repo folder that isn't
  registered, such as one `remove` left behind (`folder_exists`)
- a folder that holds something other than a repo (`not_a_workspace`)

Re-registering a left-behind folder without a word would bring back its old
models unnoticed, so `create` points at `import` instead.

If registering fails after the folder was set up, the create is undone: a
folder it made is removed, and an empty folder that was already there (it may
be the user's own) is emptied again but kept.

Reopening a registered workspace never recreates its folder unless it is the
default one under the data dir (`ensureWorkspace`). A workspace created in a
chosen folder that is later deleted is reported `workspace_missing`, like an
imported one.

## Default location

`swamp config set workspaces.dir <folder>` sets the folder new workspaces go
in when none is chosen; it must exist and is stored as its real path in
`<config dir>/workspaces.yaml`. `swamp config set workspaces.dir default`
clears it. When the folder is later deleted, creating a workspace without
`--path` fails with `parent_not_found` and says how to reset the setting.

## Removing

`remove` only drops the registry entry, and the trust with it. The folder
stays, and importing it brings the workspace back. An imported workspace is
often the user's own project, so no workspace command deletes a folder. When a
`swamp start` still has the workspace open, `remove` says so and goes ahead.

## Known gaps

`swamp start` doesn't refuse a removed workspace's folder under the data dir.
Its open path (`startOpenWorkspace`) reuses any repo under
`<data dir>/workspaces/<name>` and registers it, so
`swamp start --workspace prod` after `swamp workspace remove prod` brings the
workspace back without saying so. `workspace create` refuses the same folder
with `folder_exists`, and so does `swamp start` when the workspace goes in a
chosen or configured folder.

## Where the code lives

| Layer          | Path                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------- |
| Domain         | `src/domain/workspace/`: `WorkspaceRegistry`, `parseWorkspaceName`                                            |
| Infrastructure | `workspace_registry_file_repository.ts`; `process/start_instance_probe.ts` for "open in start"                 |
| Application    | `src/libswamp/workspace/`: the services, and `workspace_store.ts`, shared with `swamp start`                  |
| CLI            | `src/cli/commands/workspace.ts`, `src/presentation/renderers/workspace.ts`                                    |
