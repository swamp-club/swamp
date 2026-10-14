---
audience: maintainer
last-verified: 2026-10-14 @ 072d6d16
---

# Workspaces

A **workspace** is a swamp repo that Swamp keeps track of. The workspace
registry, `<config dir>/workspaces.json`, lists every workspace on the machine
by name and folder. A workspace is still an ordinary repo, so every other
command works in it unchanged.

There are two kinds:

- **Created** workspaces live under `<data dir>/workspaces/<name>`. They are
  made by `swamp workspace create` or `swamp start`, with no agent set up.
- **Imported** workspaces are existing repos registered where they are, by
  `swamp workspace import` or the import form on the `swamp start` page.
  Nothing is moved or copied.

`swamp start` uses workspaces for its tasks and launches; see
[start.md](./start.md).

## Commands

| Command                             | What it does                                                   |
| ----------------------------------- | -------------------------------------------------------------- |
| `workspace create <name>`           | Creates and registers a workspace under the data dir           |
| `workspace import <path> [--name]`  | Registers an existing repo where it is                         |
| `workspace list`                    | Lists every registered workspace, flagging gone folders        |
| `workspace get <name>`              | Shows one workspace: folder, trust, agents, open in start      |
| `workspace remove <name>`           | Takes the workspace off the registry and keeps its folder      |

`list` and `get` write nothing. Names follow `parseWorkspaceName`: one path
segment of lowercase letters, digits and dashes, at most 63 characters.

## The registry

`WorkspaceRegistry` holds the entries: name, folder, `createdAt`, and
`trustedAt` once the user confirmed that agents may work there. Names are
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

`create` takes the workspace's create lock, `<data dir>/workspaces/<name>.lock`,
the same lock `swamp start` takes. It refuses:

- a name that is registered (`name_taken`)
- a folder that is registered under another name, or a repo folder that isn't
  registered, such as one `remove` left behind (`folder_exists`)
- a folder that holds something other than a repo (`not_a_workspace`)

Re-registering a left-behind folder without a word would bring back its old
models unnoticed, so `create` points at `import` instead.

## Removing

`remove` only drops the registry entry, and the trust with it. The folder
stays, and importing it brings the workspace back. An imported workspace is
often the user's own project, so no workspace command deletes a folder. When a
`swamp start` still has the workspace open, `remove` says so and goes ahead.

## Known gaps

`swamp start` doesn't refuse a removed workspace's folder. Its open path
(`startOpenWorkspace`) reuses any repo under `<data dir>/workspaces/<name>`
and registers it, so `swamp start --workspace prod` after
`swamp workspace remove prod` brings the workspace back without saying so.
`workspace create` refuses the same folder with `folder_exists`.

## Where the code lives

| Layer          | Path                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------- |
| Domain         | `src/domain/workspace/`: `WorkspaceRegistry`, `parseWorkspaceName`                                            |
| Infrastructure | `workspace_registry_file_repository.ts`; `process/start_instance_probe.ts` for "open in start"                 |
| Application    | `src/libswamp/workspace/`: the services, and `workspace_store.ts`, shared with `swamp start`                  |
| CLI            | `src/cli/commands/workspace.ts`, `src/presentation/renderers/workspace.ts`                                    |
