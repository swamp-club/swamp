// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.

import { getLogger } from "@logtape/logtape";
import type { FolderPicker } from "../../domain/start/folder_picker.ts";
import { createSystemFolderPicker } from "../../infrastructure/process/folder_picker.ts";
import { basename, isAbsolute, join, relative, resolve } from "@std/path";
import { ensureDir } from "@std/fs";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { markErrorPaths, UserError } from "../../domain/errors.ts";
import { RepoService } from "../../domain/repo/repo_service.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { RepoMarkerRepository } from "../../infrastructure/persistence/repo_marker_repository.ts";
import { isSwampBrief, renderBrief } from "../../domain/start/brief.ts";
import {
  canResume,
  effectiveTrustMode,
  findHarness,
  HARNESSES,
  pickBinaryPath,
  planHarnessLaunch,
} from "../../domain/start/harness.ts";
import {
  type LaunchMethod,
  StartSession,
  type TrustMode,
} from "../../domain/start/start_session.ts";
import type { StartSessionRepository } from "../../domain/start/start_session_repository.ts";
import { StartTask } from "../../domain/start/start_task.ts";
import type { TerminalLauncher } from "../../domain/start/terminal_launcher.ts";
import {
  parseWorkspaceName,
  suggestWorkspaceName,
} from "../../domain/start/workspace_name.ts";
import {
  WorkspaceRegistry,
  type WorkspaceRegistryRepository,
} from "../../domain/workspace/workspace_registry.ts";
import { WorkspaceRegistryFileRepository } from "../../infrastructure/persistence/workspace_registry_file_repository.ts";
import { atomicWriteTextFile } from "../../infrastructure/persistence/atomic_write.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { YamlWorkflowRepository } from "../../infrastructure/persistence/yaml_workflow_repository.ts";
import {
  briefPath,
  refuseSymlinks,
  StartSessionFileRepository,
  startWritePaths,
} from "../../infrastructure/persistence/start_session_file_repository.ts";
import {
  createSystemTerminalLauncher,
  lookupExecutable,
} from "../../infrastructure/process/terminal/terminal_launcher.ts";
import { getSwampDataDir } from "../../infrastructure/persistence/paths.ts";
import { apiKeySourceName } from "../../infrastructure/persistence/api_key_source.ts";
import {
  authLogin,
  type AuthLoginDeps,
  type AuthLoginEvent,
  createAuthLoginDeps,
} from "../auth/login.ts";
import type { ClientIdentity } from "../../infrastructure/http/client_identity.ts";

/** Whether the user is signed in to Swamp Club, as the auth gate sees it. */
export type SignedInState =
  | {
    readonly kind: "signed_in";
    readonly username?: string;
    readonly source: "file" | "api_key";
  }
  | { readonly kind: "not_signed_in" }
  | { readonly kind: "blocked"; readonly reason: string };

/** Which screen the start page shows. */
export type StartScreen =
  | "workspace"
  | "task"
  | "sign_in"
  | "blocked"
  | "agent"
  | "trust"
  | "launched"
  /**
   * The workspace's home: every task, and the chosen one's summary with
   * its agent to reopen.
   */
  | "home";

/** Cheap local hints that order the example prompts. */
export interface StartSignals {
  readonly kubeconfig: boolean;
  readonly awsConfig: boolean;
  readonly gcloudAdc: boolean;
}

/** Everything the start page renders from. Never carries a secret. */
export interface StartStatus {
  /** Null until a workspace is chosen (screen "workspace"). */
  readonly workspacePath: string | null;
  readonly workspaceName: string | null;
  readonly signedIn: "signed_in" | "not_signed_in" | "blocked";
  readonly username?: string;
  readonly blockedReason?: string;
  readonly screen: StartScreen;
  /** The task the page has open, or none (a new task is being written). */
  readonly taskId?: string;
  readonly task?: {
    readonly text: string;
    readonly title: string;
    /** When the task was created (ISO). */
    readonly createdAt: string;
    /** Its brief, relative to the workspace, once it has one. */
    readonly briefFile?: string;
  };
  readonly harness?: {
    readonly id: string;
    readonly displayName: string;
    readonly trustMode: TrustMode;
    /** True when reopening it continues the previous conversation. */
    readonly canResume: boolean;
  };
  readonly launch?: {
    readonly method: LaunchMethod;
    readonly command: string;
    readonly opened: boolean;
    readonly at: string;
  };
  /** Definitions in the workspace now: what the agent has built so far. */
  readonly contents?: StartContents;
  /** Tools the workspace is set up for already (its `.swamp.yaml`). */
  readonly enrolledTools?: readonly string[];
  /** Tools chosen for this task, the harness included. */
  readonly tools?: readonly string[];
  /** True when another `swamp start` has this workspace open too. */
  readonly alsoOpenElsewhere?: boolean;
  /** Every task of the workspace, newest first. Set once one is chosen. */
  readonly tasks?: readonly StartTaskSummary[];
  /**
   * True when the user confirmed, on this machine, that agents may work in
   * the workspace (recorded in the workspace registry, never read from the
   * workspace). Until then every agent launch asks for that confirmation.
   */
  readonly trusted: boolean;
  /**
   * The agent (a harness id) the user last picked for a task, in any
   * workspace: a new task starts with it selected when it can launch.
   */
  readonly lastAgent?: string;
  /**
   * True when the server can show this machine's folder chooser for an
   * import (not over SSH or without a display).
   */
  readonly canPickFolder: boolean;
  readonly apiKeyFromEnv: boolean;
  readonly signals: StartSignals;
}

/** What a workspace holds: its models and workflows, by name. */
export interface StartContents {
  readonly models: number;
  readonly workflows: number;
  /** Up to {@link CONTENTS_LIMIT} models, by name and type. */
  readonly modelList: readonly {
    readonly name: string;
    readonly type: string;
  }[];
  /** Up to {@link CONTENTS_LIMIT} workflow names. */
  readonly workflowList: readonly string[];
}

/** How many models and workflows a summary names before "+N more". */
const CONTENTS_LIMIT = 8;

/** One supported harness, and whether this machine has it on PATH. */
export interface StartHarnessInfo {
  readonly id: string;
  readonly displayName: string;
  /** The executable looked up on PATH. */
  readonly binary: string;
  readonly binaryPath: string | null;
  readonly found: boolean;
  readonly trustMode: TrustMode;
  readonly launchable: boolean;
}

/** One workspace under the data dir, as the picker shows it. */
export interface StartWorkspaceSummary {
  readonly name: string;
  readonly path: string;
  /** The newest task's step, title and agent; null with no tasks. */
  readonly step: StartSession["step"] | null;
  readonly taskTitle: string | null;
  readonly harness: string | null;
  readonly harnessDisplayName: string | null;
  /** Every task of the workspace, newest first. */
  readonly tasks: readonly StartTaskSummary[];
  /** Tools the workspace is set up for (its `.swamp.yaml`). */
  readonly enrolledTools: readonly string[];
  /** When the workspace was created, or null when unknown. */
  readonly createdAt: string | null;
  /** When one of its tasks last changed, or null when it has none. */
  readonly updatedAt: string | null;
  /** True when another `swamp start` is serving it. */
  readonly running: boolean;
  /** True when its folder is outside the data dir: an imported repo. */
  readonly imported: boolean;
}

/** Enrols tools and creates the workspace repo. */
export interface StartRepoOps {
  /** True when the folder holds a `.swamp.yaml`. */
  isRepo(path: string): Promise<boolean>;
  init(path: string): Promise<void>;
  enrolledTools(path: string): Promise<string[]>;
  /** When the repo was initialised (`.swamp.yaml` initializedAt). */
  createdAt?(path: string): Promise<string | null>;
  setTools(path: string, tools: string[]): Promise<void>;
}

/** Dependencies of the start services, injected for testing. */
export interface StartDeps {
  /** The swamp data dir the workspaces live under. */
  readonly dataDir: string;
  readonly os: string;
  readonly checkSignedIn: (live: boolean) => Promise<SignedInState>;
  readonly apiKeyFromEnv: () => boolean;
  readonly repo: StartRepoOps;
  readonly sessions: StartSessionRepository;
  /** All lookup hits for an executable name, best first. */
  readonly lookup: (name: string) => Promise<string[]>;
  readonly terminalLauncher: TerminalLauncher;
  /** Writes a task's brief (`briefFile` is workspace-relative). */
  readonly writeBrief: (
    workspacePath: string,
    briefFile: string,
    content: string,
  ) => Promise<void>;
  readonly signals: () => Promise<StartSignals>;
  readonly signIn: (ctx: LibSwampContext) => AsyncIterable<AuthLoginEvent>;
  readonly now: () => Date;
  readonly randomUUID: () => string;
  /** Values in [0, 1), for suggested workspace names. */
  readonly random: () => number;
  /** True when another `swamp start` is serving the workspace. */
  readonly isRunning: (workspacePath: string) => Promise<boolean>;
  /** Every workspace Swamp knows about, wherever its folder is. */
  readonly registry: WorkspaceRegistryRepository;
  /** The user's home folder, for `~` in an imported path; unset when unknown. */
  readonly homeDir?: string;
  /**
   * A task's brief file as it is now, or null when there is none. Defaults
   * to reading the file.
   */
  readonly readBrief?: (
    workspacePath: string,
    briefFile: string,
  ) => Promise<string | null>;
  /** The OS folder chooser for imports; none means typing the path only. */
  readonly folderPicker?: FolderPicker;
}

/**
 * Throws unless the user is signed in to Swamp Club. Everything that writes
 * to a workspace (creating or importing one, setting tools up, saving or
 * launching a task) needs it: `swamp start` is exempt from the auth gate
 * only so it can sign the user in.
 *
 * @throws {UserError} code `not_signed_in`, or `blocked` with the reason
 */
async function requireSignedIn(
  deps: StartDeps,
  action = "before you continue",
): Promise<SignedInState> {
  const signedIn = await deps.checkSignedIn(true);
  if (signedIn.kind === "blocked") {
    throw new UserError(signedIn.reason, "blocked");
  }
  if (signedIn.kind !== "signed_in") {
    throw new UserError(`Sign in to Swamp Club ${action}.`, "not_signed_in");
  }
  return signedIn;
}

/** The folder new workspaces are created in. */
function workspacesRoot(deps: StartDeps): string {
  return join(deps.dataDir, "workspaces");
}

/**
 * True when the workspace is a folder imported where it was, not one
 * `swamp start` created under the data dir.
 */
function isImported(deps: StartDeps, workspacePath: string): boolean {
  return !isUnder(workspacePath, workspacesRoot(deps));
}

/**
 * The folder a new workspace of that name gets: under the data dir. A
 * registered workspace may live anywhere; see {@link resolveStartWorkspacePath}.
 */
export function startWorkspacePath(dataDir: string, name: string): string {
  return join(dataDir, "workspaces", parseWorkspaceName(name));
}

/**
 * The registry, adopting the workspaces already under the data dir the
 * first time it is read (before the registry existed, `swamp start` only
 * created folders there).
 */
async function workspaceRegistry(
  deps: StartDeps,
  options: { readOnly?: boolean } = {},
): Promise<WorkspaceRegistry> {
  const existing = await deps.registry.load();
  if (existing) return existing;
  const root = workspacesRoot(deps);
  const found: string[] = [];
  try {
    for await (const entry of Deno.readDir(root)) {
      if (entry.isDirectory && await deps.repo.isRepo(join(root, entry.name))) {
        found.push(entry.name);
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const createdAt = deps.now().toISOString();
  if (options.readOnly) {
    // Report what adoption would register, without writing anything.
    return WorkspaceRegistry.fromEntries(
      found.map((name) => ({ name, path: join(root, name), createdAt })),
    );
  }
  return await deps.registry.update((registry) => {
    for (const name of found) {
      try {
        registry.register({ name, path: join(root, name), createdAt });
      } catch {
        // A name or folder already registered by another process meanwhile.
      }
    }
    return registry;
  });
}

/** The folder of a workspace: where it is registered, else the default. */
export async function resolveStartWorkspacePath(
  deps: StartDeps,
  name: string,
): Promise<string> {
  const parsed = parseWorkspaceName(name);
  // Only a lookup: opening the workspace registers it, after sign-in.
  const registry = await workspaceRegistry(deps, { readOnly: true });
  return registry.get(parsed)?.path ?? startWorkspacePath(deps.dataDir, parsed);
}

async function ensureRegistered(
  deps: StartDeps,
  name: string,
  path: string,
): Promise<void> {
  await deps.registry.update((registry) => {
    if (!registry.get(name)) {
      registry.register({ name, path, createdAt: deps.now().toISOString() });
    }
  });
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function deriveScreen(
  session: StartSession | null,
  signedIn: SignedInState,
): StartScreen {
  if (signedIn.kind === "blocked") return "blocked";
  if (signedIn.kind === "not_signed_in") return "sign_in";
  // No task chosen: a new one is being written.
  return session?.step ?? "task";
}

/**
 * Builds the status the page renders from, for a workspace and the task the
 * page has open (none while a new task is written).
 */
export function buildStartStatus(
  workspacePath: string,
  session: StartSession | null,
  signedIn: SignedInState,
  apiKeyFromEnv: boolean,
  signals: StartSignals,
  os: string = Deno.build.os,
  contents?: StartContents,
  enrolledTools?: readonly string[],
): StartStatus {
  const task = session?.task;
  const harness = session?.harness ? findHarness(session.harness) : undefined;
  const launch = session?.launch;
  return {
    workspacePath,
    workspaceName: basename(workspacePath),
    signedIn: signedIn.kind,
    ...(signedIn.kind === "signed_in" && signedIn.username
      ? { username: signedIn.username }
      : {}),
    ...(signedIn.kind === "blocked" ? { blockedReason: signedIn.reason } : {}),
    screen: deriveScreen(session, signedIn),
    ...(session ? { taskId: session.id } : {}),
    ...(session && task
      ? {
        task: {
          text: task.text,
          title: task.title(),
          createdAt: session.createdAt,
          ...(session.briefFile ? { briefFile: session.briefFile } : {}),
        },
      }
      : {}),
    ...(harness
      ? {
        harness: {
          id: harness.id,
          displayName: harness.displayName,
          trustMode: effectiveTrustMode(harness, os),
          canResume: canResume(harness),
        },
      }
      : {}),
    ...(launch
      ? {
        launch: {
          method: launch.method,
          command: launch.command,
          opened: launch.opened,
          at: launch.at,
        },
      }
      : {}),
    ...(contents ? { contents } : {}),
    ...(enrolledTools ? { enrolledTools } : {}),
    ...(session?.harness ? { tools: session.tools } : {}),
    trusted: false,
    canPickFolder: false,
    apiKeyFromEnv,
    signals,
  };
}

/** The status before a workspace is chosen. */
export function buildUnboundStatus(
  signedIn: SignedInState,
  apiKeyFromEnv: boolean,
  signals: StartSignals,
): StartStatus {
  return {
    workspacePath: null,
    workspaceName: null,
    signedIn: signedIn.kind,
    ...(signedIn.kind === "signed_in" && signedIn.username
      ? { username: signedIn.username }
      : {}),
    ...(signedIn.kind === "blocked" ? { blockedReason: signedIn.reason } : {}),
    screen: signedIn.kind === "blocked"
      ? "blocked"
      : signedIn.kind === "not_signed_in"
      ? "sign_in"
      : "workspace",
    trusted: false,
    canPickFolder: false,
    apiKeyFromEnv,
    signals,
  };
}

async function unboundStatus(deps: StartDeps): Promise<StartStatus> {
  return {
    ...buildUnboundStatus(
      await deps.checkSignedIn(true),
      deps.apiKeyFromEnv(),
      await deps.signals(),
    ),
    canPickFolder: await canPickFolder(deps),
  };
}

/** Whether the folder chooser can be offered; a failed check means no. */
async function canPickFolder(deps: StartDeps): Promise<boolean> {
  try {
    return await deps.folderPicker?.available() ?? false;
  } catch {
    return false;
  }
}

/**
 * The workspace's task with that id.
 *
 * @throws {UserError} code `task_missing` when there is none
 */
async function loadTask(
  deps: StartDeps,
  workspacePath: string,
  id: string,
): Promise<StartSession> {
  const task = await deps.sessions.load(workspacePath, id);
  if (!task) {
    throw new UserError(
      "That task isn't in this workspace any more.",
      "task_missing",
    );
  }
  return task;
}

/** One task of a workspace, as the task list shows it. */
export interface StartTaskSummary {
  readonly id: string;
  readonly title: string;
  readonly step: StartSession["step"];
  readonly harness: string | null;
  readonly harnessDisplayName: string | null;
  /** When the task was created (ISO). The list is ordered by it. */
  readonly createdAt: string;
  readonly launchedAt: string | null;
  /** Its brief, relative to the workspace, once it has one. */
  readonly briefFile: string | null;
}

function summariseTask(session: StartSession): StartTaskSummary | null {
  const task = session.task;
  if (!task) return null;
  const harness = session.harness ? findHarness(session.harness) : undefined;
  return {
    id: session.id,
    title: task.title(),
    step: session.step,
    harness: harness?.id ?? null,
    harnessDisplayName: harness?.displayName ?? null,
    createdAt: session.createdAt,
    launchedAt: session.launch?.at ?? null,
    briefFile: session.briefFile ?? null,
  };
}

/** Every task of the workspace, newest first by when it was created. */
async function listTasks(
  deps: StartDeps,
  workspacePath: string,
): Promise<StartTaskSummary[]> {
  return (await deps.sessions.list(workspacePath))
    .map(summariseTask)
    .filter((t): t is StartTaskSummary => t !== null)
    .sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)
    );
}

/**
 * The models and workflows a workspace holds, read through swamp's own
 * definition and workflow repositories, so it matches `swamp model search`
 * and `swamp workflow search` rather than guessing from files.
 */
async function listContents(workspacePath: string): Promise<StartContents> {
  let models: { name: string; type: string }[] = [];
  let workflows: string[] = [];
  try {
    // Only the workspace's own definitions are listed, so no auto-definition
    // directory (which is datastore-tier) is read.
    models = (await new YamlDefinitionRepository(
      workspacePath,
      undefined,
      undefined,
      false,
    ).findAllGlobal())
      .map(({ definition, type }) => ({
        name: definition.name,
        type: type.toString(),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    models = [];
  }
  try {
    workflows = (await new YamlWorkflowRepository(workspacePath).findAll())
      .map((w) => w.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    workflows = [];
  }
  return {
    models: models.length,
    workflows: workflows.length,
    modelList: models.slice(0, CONTENTS_LIMIT),
    workflowList: workflows.slice(0, CONTENTS_LIMIT),
  };
}

async function statusOf(
  deps: StartDeps,
  workspacePath: string,
  session: StartSession | null,
  signedIn?: SignedInState,
): Promise<StartStatus> {
  const status = buildStartStatus(
    workspacePath,
    session,
    signedIn ?? await deps.checkSignedIn(true),
    deps.apiKeyFromEnv(),
    await deps.signals(),
    deps.os,
    await listContents(workspacePath),
    await deps.repo.enrolledTools(workspacePath),
  );
  const registry = await deps.registry.load();
  const lastAgent = registry?.lastAgent();
  return {
    ...status,
    ...(await deps.isRunning(workspacePath) ? { alsoOpenElsewhere: true } : {}),
    tasks: await listTasks(deps, workspacePath),
    trusted: registry?.isTrusted(workspacePath) ?? false,
    ...(lastAgent !== undefined ? { lastAgent } : {}),
    canPickFolder: await canPickFolder(deps),
  };
}

/**
 * Refuses to open an agent in a folder the user hasn't trusted on this
 * machine. Trust is recorded in the workspace registry (the config dir),
 * never taken from the workspace's own files: an imported repo can carry any
 * `.swamp/start/state.json` it likes, including one that says its task was
 * launched. `confirmed` is the user's confirmation sent with this request,
 * which is recorded.
 *
 * @throws {UserError} code `trust_required`
 */
async function requireTrust(
  deps: StartDeps,
  workspacePath: string,
  confirmed: boolean,
): Promise<void> {
  if ((await deps.registry.load())?.isTrusted(workspacePath)) return;
  if (!confirmed) {
    throw new UserError(
      "Confirm you trust this folder before an agent opens in it.",
      "trust_required",
    );
  }
  await deps.registry.update((registry) => {
    registry.markTrusted(workspacePath, deps.now().toISOString());
  });
}

/** Events of the operations that answer with a status. */
export type StartStatusEvent =
  | { kind: "completed"; data: StartStatus }
  | { kind: "error"; error: SwampError };

function errorEvent(error: unknown): { kind: "error"; error: SwampError } {
  if (error instanceof UserError) {
    return {
      kind: "error",
      error: { code: error.code ?? "user_error", message: error.message },
    };
  }
  throw error;
}

/**
 * Runs one command on a task: re-reads it, applies the change, saves it
 * and answers with the status.
 */
function taskCommand(
  deps: StartDeps,
  workspacePath: string,
  taskId: string,
  apply: (session: StartSession) => void | Promise<void>,
): AsyncIterable<StartStatusEvent> {
  return (async function* () {
    try {
      const session = await loadTask(deps, workspacePath, taskId);
      await apply(session);
      await deps.sessions.save(session);
      yield {
        kind: "completed",
        data: await statusOf(deps, workspacePath, session),
      };
    } catch (error) {
      yield errorEvent(error);
    }
  })();
}

/**
 * The status of a workspace and the task the page has open (none while a
 * new task is written); with no workspace chosen, the workspace screen.
 * Never writes anything.
 */
export function startStatus(
  _ctx: LibSwampContext,
  deps: StartDeps,
  input: { workspacePath: string | null; taskId?: string },
): AsyncIterable<StartStatusEvent> {
  const workspacePath = input.workspacePath;
  return (async function* () {
    try {
      if (workspacePath === null) {
        yield { kind: "completed" as const, data: await unboundStatus(deps) };
        return;
      }
      const session = input.taskId === undefined
        ? null
        : await loadTask(deps, workspacePath, input.taskId);
      yield {
        kind: "completed" as const,
        data: await statusOf(deps, workspacePath, session),
      };
    } catch (error) {
      yield errorEvent(error);
    }
  })();
}

/**
 * Saves a task's text. With no `taskId` it creates a new task, giving it
 * its brief path; otherwise it changes the text of that task, which is
 * only allowed until it is launched. The status names the task.
 */
export function startSaveTask(
  _ctx: LibSwampContext,
  deps: StartDeps,
  input: { workspacePath: string; taskId?: string; text: string },
): AsyncIterable<StartStatusEvent> {
  if (input.taskId !== undefined) {
    return taskCommand(deps, input.workspacePath, input.taskId, async (s) => {
      await requireSignedIn(deps);
      s.saveTask(StartTask.create(input.text));
    });
  }
  return (async function* () {
    try {
      await requireSignedIn(deps);
      const task = StartTask.create(input.text);
      const session = StartSession.create(
        deps.randomUUID(),
        input.workspacePath,
        deps.now(),
      );
      session.saveTask(task);
      session.assignBriefFile(
        await deps.sessions.reserveBriefFile(
          input.workspacePath,
          session.createdAt,
          task.title(),
        ),
      );
      await deps.sessions.save(session);
      yield {
        kind: "completed",
        data: await statusOf(deps, input.workspacePath, session),
      };
    } catch (error) {
      yield errorEvent(error);
    }
  })();
}

export function startBack(
  _ctx: LibSwampContext,
  deps: StartDeps,
  input: { workspacePath: string; taskId: string },
): AsyncIterable<StartStatusEvent> {
  return taskCommand(deps, input.workspacePath, input.taskId, (s) => s.back());
}

export function startChooseHarness(
  _ctx: LibSwampContext,
  deps: StartDeps,
  input: {
    workspacePath: string;
    taskId: string;
    harness: string;
    tools?: readonly string[];
  },
): AsyncIterable<StartStatusEvent> {
  return taskCommand(deps, input.workspacePath, input.taskId, async (s) => {
    await requireSignedIn(deps);
    const harness = findHarness(input.harness);
    if (!harness) throw new UserError(`Unknown agent "${input.harness}".`);
    if (!harness.launchable) {
      throw new UserError(
        `${harness.displayName} can't be started with a task yet. Pick another agent.`,
      );
    }
    if (!await resolveHarnessBinary(deps, harness.binary)) {
      throw new UserError(
        `${harness.displayName} (\`${harness.binary}\`) isn't on your PATH. Install it, or pick another agent.`,
      );
    }
    const extras = (input.tools ?? []).map((id) => {
      const tool = findHarness(id);
      if (!tool) throw new UserError(`Unknown agent "${id}".`);
      return tool.id;
    });
    s.chooseHarness(harness.id, extras);
    // Adopt first: the first write of the registry must not skip the
    // workspaces already under the data dir.
    await workspaceRegistry(deps);
    await deps.registry.update((registry) =>
      registry.rememberAgent(harness.id)
    );
  });
}

/** Every task of the workspace, newest first by when it was created. */
export async function startListTasks(
  _ctx: LibSwampContext,
  deps: StartDeps,
  input: { workspacePath: string },
): Promise<StartTaskSummary[]> {
  return await listTasks(deps, input.workspacePath);
}

// ---------------------------------------------------------------------------
// Prepare
// ---------------------------------------------------------------------------

export type StartPrepareEvent =
  | { kind: "signed_in_checked"; state: SignedInState }
  | { kind: "workspace_ready"; path: string; created: boolean }
  | { kind: "completed"; data: StartStatus }
  | { kind: "error"; error: SwampError };

async function folderState(
  path: string,
): Promise<"missing" | "empty" | "not_empty"> {
  try {
    for await (const _entry of Deno.readDir(path)) return "not_empty";
    return "empty";
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return "missing";
    throw error;
  }
}

/**
 * Creates the workspace folder and initialises it as a repo with no tools,
 * or reuses it. Refuses a folder that holds something other than a
 * workspace. Returns true when it created the workspace.
 */
async function ensureWorkspace(
  deps: StartDeps,
  name: string,
  workspacePath: string,
): Promise<boolean> {
  if (await deps.repo.isRepo(workspacePath)) return false;
  // Only the default folder under the data dir is ever created. A workspace
  // registered elsewhere (an imported repo) that is gone is not recreated
  // empty in its place.
  if (
    resolve(workspacePath) !== resolve(startWorkspacePath(deps.dataDir, name))
  ) {
    throw markErrorPaths(
      new UserError(
        `The workspace "${name}" is registered at ${workspacePath}, but there's no Swamp workspace there any more. Put the folder back, or import it again from where it is now.`,
        "workspace_missing",
      ),
      [workspacePath],
    );
  }
  const state = await folderState(workspacePath);
  if (state === "not_empty") {
    throw markErrorPaths(
      new UserError(
        `${workspacePath} exists but isn't a Swamp workspace. Move it aside, or choose another name.`,
        "not_a_workspace",
      ),
      [workspacePath],
    );
  }
  await ensureDir(workspacePath);
  await deps.repo.init(workspacePath);
  return true;
}

/**
 * Converts a workspace's files from before every task had its own record
 * and brief. What can't be read is kept where it is, with a warning.
 */
/**
 * Records a launch after the agent's window has opened. The agent is
 * already running by then, so a failed save is a warning, not an error:
 * reporting the launch as failed would invite a second agent on the same
 * brief.
 */
async function saveLaunch(
  deps: StartDeps,
  session: StartSession,
): Promise<void> {
  try {
    await deps.sessions.save(session);
  } catch (error) {
    getLogger(["swamp", "start"])
      .warn`The agent started, but its launch couldn't be recorded: ${error}`;
  }
}

async function migrateLegacyTasks(
  deps: StartDeps,
  workspacePath: string,
): Promise<void> {
  const { kept } = await deps.sessions.migrateLegacy(workspacePath);
  for (const path of kept) {
    getLogger(["swamp", "start"])
      .warn`Couldn't read an earlier task in ${workspacePath}; kept it as ${path}`;
  }
}

/**
 * Creates or reuses a workspace by name and shows its newest task.
 * The caller holds the workspace's claim (its creation lock and server
 * record); several `swamp start` processes may serve one workspace.
 */
export function startOpenWorkspace(
  _ctx: LibSwampContext,
  deps: StartDeps,
  input: { workspaceName: string },
): AsyncIterable<StartPrepareEvent> {
  return openWorkspace(deps, input.workspaceName);
}

async function* openWorkspace(
  deps: StartDeps,
  workspaceName: string,
  checked?: SignedInState,
): AsyncIterable<StartPrepareEvent> {
  try {
    const signedIn = checked ?? await deps.checkSignedIn(true);
    if (signedIn.kind === "blocked") {
      throw new UserError(signedIn.reason, "blocked");
    }
    if (signedIn.kind !== "signed_in") {
      throw new UserError(
        "Sign in to Swamp Club before you open a workspace.",
        "not_signed_in",
      );
    }
    let name: string;
    let workspacePath: string;
    try {
      name = parseWorkspaceName(workspaceName);
      workspacePath = await resolveStartWorkspacePath(deps, name);
    } catch (error) {
      if (
        error instanceof UserError && error.code !== "registry_unreadable"
      ) {
        throw new UserError(error.message, "invalid_name");
      }
      throw error;
    }
    const created = await ensureWorkspace(deps, name, workspacePath);
    await ensureRegistered(deps, name, workspacePath);
    await migrateLegacyTasks(deps, workspacePath);
    yield { kind: "workspace_ready", path: workspacePath, created };
    // The newest task is shown first; a workspace with none starts on a new
    // task.
    const newest = (await listTasks(deps, workspacePath))[0];
    const session = newest
      ? await loadTask(deps, workspacePath, newest.id)
      : null;
    yield {
      kind: "completed",
      data: await statusOf(deps, workspacePath, session, signedIn),
    };
  } catch (error) {
    yield errorEvent(error);
  }
}

/**
 * Checks sign-in and, when a workspace is named, opens it. With no name the
 * status reports the workspace screen, and the page picks one.
 */
export async function* startPrepare(
  _ctx: LibSwampContext,
  deps: StartDeps,
  input: { workspaceName?: string },
): AsyncIterable<StartPrepareEvent> {
  let signedIn: SignedInState;
  try {
    signedIn = await deps.checkSignedIn(true);
    yield { kind: "signed_in_checked", state: signedIn };
    if (input.workspaceName === undefined) {
      yield {
        kind: "completed",
        data: {
          ...buildUnboundStatus(
            signedIn,
            deps.apiKeyFromEnv(),
            await deps.signals(),
          ),
          canPickFolder: await canPickFolder(deps),
        },
      };
      return;
    }
  } catch (error) {
    yield errorEvent(error);
    return;
  }
  yield* openWorkspace(deps, input.workspaceName, signedIn);
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

async function mtimeOf(path: string): Promise<Date | null> {
  try {
    return (await Deno.stat(path)).mtime;
  } catch {
    return null;
  }
}

/** The workspaces under the data dir, newest first, plus a fresh name. */
export async function startListWorkspaces(
  _ctx: LibSwampContext,
  deps: StartDeps,
  options: { readOnly?: boolean } = {},
): Promise<{ workspaces: StartWorkspaceSummary[]; suggestedName: string }> {
  const root = workspacesRoot(deps);
  const registry = await workspaceRegistry(deps, options);
  // Folder names under the data dir count as taken too, so a suggestion
  // never collides with a folder that isn't registered.
  const taken = new Set(registry.list().map((e) => e.name));
  try {
    for await (const entry of Deno.readDir(root)) {
      if (entry.isDirectory) taken.add(entry.name);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const summaries = await Promise.all(
    registry.list().map(({ name, path }) =>
      // One workspace that can't be read (a damaged `.swamp.yaml` or
      // session file) is left out rather than hiding all the others.
      summarize(name, path).catch(() => null)
    ),
  );
  async function summarize(
    name: string,
    path: string,
  ): Promise<StartWorkspaceSummary | null> {
    // A registered folder that is gone or no longer a repo is left out.
    if (!await deps.repo.isRepo(path)) return null;
    const tasks = await listTasks(deps, path);
    const newest = tasks[0];
    const lastChange = tasks
      .map((t) => t.launchedAt ?? t.createdAt)
      .sort()
      .at(-1);
    const updated = lastChange ??
      (await mtimeOf(join(path, ".swamp.yaml")))?.toISOString() ?? null;
    const summary: StartWorkspaceSummary = {
      name,
      path,
      step: newest?.step ?? null,
      taskTitle: newest?.title ?? null,
      harness: newest?.harness ?? null,
      harnessDisplayName: newest?.harnessDisplayName ?? null,
      tasks,
      enrolledTools: await deps.repo.enrolledTools(path),
      createdAt: (await deps.repo.createdAt?.(path)) ?? null,
      updatedAt: updated,
      running: await deps.isRunning(path),
      imported: isImported(deps, path),
    };
    return summary;
  }
  const workspaces = summaries.filter((w): w is StartWorkspaceSummary =>
    w !== null
  );
  workspaces.sort((a, b) =>
    (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")
  );
  return {
    workspaces,
    suggestedName: suggestWorkspaceName(taken, deps.random),
  };
}

function isUnder(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** A workspace name made from a folder name: lowercase, dashes, ≤ 63. */
function nameFromFolder(folder: string): string {
  const slug = folder.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(
    /^-+|-+$/g,
    "",
  ).slice(0, 63).replace(/-+$/, "");
  return slug || "workspace";
}

/** What the folder chooser asks. */
export const PICK_FOLDER_PROMPT = "Choose the swamp repo to import";

/**
 * Shows this machine's folder chooser for an import and answers with the
 * chosen folder, or null when the user cancelled. Nothing is imported: the
 * page fills its folder field and the user still confirms.
 *
 * @throws {UserError} code `not_signed_in`, or `picker_unavailable` when no
 *   chooser can be shown here (over SSH, without a display)
 */
export async function startPickFolder(
  _ctx: LibSwampContext,
  deps: StartDeps,
): Promise<{ path: string | null }> {
  await requireSignedIn(deps, "before importing a workspace");
  if (!await canPickFolder(deps)) {
    throw new UserError(
      "This machine can't show a folder chooser here. Type the folder's path instead.",
      "picker_unavailable",
    );
  }
  return { path: await deps.folderPicker!.pick(PICK_FOLDER_PROMPT) };
}

/**
 * Registers an existing swamp repo as a workspace where it is: nothing is
 * moved or copied. The name defaults to the folder's name; a clash gets a
 * numeric suffix. Importing a folder that is already registered answers
 * with its existing name.
 */
/**
 * The folder a typed path names, checked the way an import checks it: it
 * exists and holds a \`.swamp.yaml\`.
 *
 * @throws {UserError} code \`not_found\` or \`not_a_repo\`
 */
async function importableFolder(
  deps: StartDeps,
  typed: string,
): Promise<string> {
  const raw = typed.trim();
  if (raw === "") {
    throw new UserError("Enter the folder to import.", "not_found");
  }
  const path = resolve(expandHome(raw, deps.homeDir, deps.os));
  let isDirectory = false;
  try {
    isDirectory = (await Deno.stat(path)).isDirectory;
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    throw markErrorPaths(
      new UserError(`There's no folder at ${path}.`, "not_found"),
      [path],
    );
  }
  if (!await deps.repo.isRepo(path)) {
    throw markErrorPaths(
      new UserError(
        `${path} isn't a swamp folder.`,
        "not_a_repo",
      ),
      [path],
    );
  }
  return path;
}

/** What the import form shows for a folder before it is imported. */
export type StartFolderCheck =
  | {
    readonly ok: true;
    readonly path: string;
    /** Set when the folder is already a registered workspace. */
    readonly registeredAs?: string;
  }
  | {
    readonly ok: false;
    readonly code: "not_found" | "not_a_repo";
    readonly message: string;
  };

/**
 * Checks a folder for import without importing it: the same rules as
 * {@link startImportWorkspace}, and the name it is already registered
 * under, if any. Reads only.
 */
export async function startCheckFolder(
  _ctx: LibSwampContext,
  deps: StartDeps,
  input: { path: string },
): Promise<StartFolderCheck> {
  await requireSignedIn(deps, "before you import a workspace");
  let path: string;
  try {
    path = await importableFolder(deps, input.path);
  } catch (error) {
    if (
      error instanceof UserError &&
      (error.code === "not_found" || error.code === "not_a_repo")
    ) {
      // Short: the form shows the folder right above the message.
      return {
        ok: false,
        code: error.code,
        message: error.code === "not_found"
          ? "There's no folder at that path."
          : "This isn't a swamp folder.",
      };
    }
    throw error;
  }
  const real = await realPathOrSelf(path);
  const registry = await workspaceRegistry(deps, { readOnly: true });
  for (const entry of registry.list()) {
    if (await realPathOrSelf(entry.path) === real) {
      return { ok: true, path, registeredAs: entry.name };
    }
  }
  return { ok: true, path };
}

export async function startImportWorkspace(
  _ctx: LibSwampContext,
  deps: StartDeps,
  input: { path: string; name?: string },
): Promise<{ name: string; path: string }> {
  await requireSignedIn(deps, "before you import a workspace");
  const path = await importableFolder(deps, input.path);
  // The folder as it really is (symlinks and /tmp vs /private/tmp
  // resolved), so one folder is only ever registered once.
  const real = await Deno.realPath(path);
  const wanted = input.name?.trim()
    ? parseWorkspaceNameWithCode(input.name.trim())
    : null;
  const known = await workspaceRegistry(deps);
  const sameFolder = new Set<string>([real]);
  await Promise.all(
    known.list().map(async (entry) => {
      if (await realPathOrSelf(entry.path) === real) sameFolder.add(entry.path);
    }),
  );
  return await deps.registry.update((registry) => {
    const existing = registry.list().find((e) => sameFolder.has(e.path));
    if (existing) return { name: existing.name, path: existing.path };
    let name = wanted ?? nameFromFolder(basename(real));
    if (registry.get(name)) {
      if (wanted) {
        throw new UserError(
          `A workspace named "${name}" already exists. Choose another name.`,
          "name_taken",
        );
      }
      const base = name;
      for (let n = 2; registry.get(name); n++) {
        const suffix = `-${n}`;
        // Names are at most 63 characters, suffix included.
        name = `${base.slice(0, 63 - suffix.length)}${suffix}`;
      }
    }
    registry.register({
      name,
      path: real,
      createdAt: deps.now().toISOString(),
    });
    return { name, path: real };
  });
}

/**
 * Expands a leading `~` (`~/…`, or `~\…` on Windows) to the home folder.
 *
 * @throws {UserError} code `not_found` when there is a `~` to expand but
 *   the home folder is unknown
 */
export function expandHome(
  raw: string,
  homeDir: string | undefined,
  os: string,
): string {
  const tilde = raw === "~" || raw.startsWith("~/") ||
    (os === "windows" && raw.startsWith("~\\"));
  if (!tilde) return raw;
  if (!homeDir) {
    throw new UserError(
      "Swamp can't tell where your home folder is. Enter the folder's full path.",
      "not_found",
    );
  }
  return raw === "~" ? homeDir : join(homeDir, raw.slice(2));
}

async function realPathOrSelf(path: string): Promise<string> {
  try {
    return await Deno.realPath(path);
  } catch {
    return path;
  }
}

function parseWorkspaceNameWithCode(name: string): string {
  try {
    return parseWorkspaceName(name);
  } catch (error) {
    if (error instanceof UserError) {
      throw new UserError(error.message, "invalid_name");
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Harnesses
// ---------------------------------------------------------------------------

async function resolveHarnessBinary(
  deps: StartDeps,
  binary: string,
): Promise<string | null> {
  return pickBinaryPath(await deps.lookup(binary), deps.os);
}

/**
 * Every harness swamp supports (the `--tool` values), in the order the page
 * lists them, with whether each one is on PATH.
 */
export async function startListHarnesses(
  _ctx: LibSwampContext,
  deps: StartDeps,
): Promise<StartHarnessInfo[]> {
  // Looked up concurrently; Promise.all keeps the table's order.
  return await Promise.all(HARNESSES.map(async (harness) => {
    const binaryPath = await resolveHarnessBinary(deps, harness.binary);
    return {
      id: harness.id,
      displayName: harness.displayName,
      binary: harness.binary,
      binaryPath,
      found: binaryPath !== null,
      trustMode: effectiveTrustMode(harness, deps.os),
      launchable: harness.launchable,
    };
  }));
}

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

/** The sign-in events the browser may see. Never the API key or email. */
export type StartSignInEvent =
  | {
    kind: "device_verification";
    userCode: string;
    verificationUri: string;
    verificationUriComplete?: string;
  }
  | { kind: "polling" }
  | { kind: "securing_session" }
  | { kind: "completed"; username: string }
  | { kind: "error"; message: string };

/** Whitelists one auth login event for the browser, or drops it. */
function projectSignInEvent(
  event: AuthLoginEvent,
): StartSignInEvent | null {
  switch (event.kind) {
    case "device_verification":
      return {
        kind: "device_verification",
        userCode: event.userCode,
        verificationUri: event.verificationUri,
        ...(event.verificationUriComplete
          ? { verificationUriComplete: event.verificationUriComplete }
          : {}),
      };
    case "polling":
      return { kind: "polling" };
    case "securing_session":
      return { kind: "securing_session" };
    case "completed":
      return { kind: "completed", username: event.data.username };
    case "error":
      return { kind: "error", message: event.error.message };
    default:
      return null;
  }
}

/** Signs the user in through the device flow, forwarding whitelisted events. */
export async function* startSignIn(
  ctx: LibSwampContext,
  deps: StartDeps,
): AsyncIterable<StartSignInEvent> {
  if (deps.apiKeyFromEnv()) {
    yield {
      kind: "error",
      message:
        "You're signed in through an API key environment variable. Unset it to sign in here.",
    };
    return;
  }
  try {
    for await (const event of deps.signIn(ctx)) {
      const projected = projectSignInEvent(event);
      if (projected) yield projected;
    }
  } catch (error) {
    yield {
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

export type StartLaunchEvent =
  | { kind: "checking" }
  | { kind: "enrolling"; tool: string }
  | { kind: "brief_written"; path: string }
  | { kind: "window_opening" }
  | { kind: "launched"; method: LaunchMethod; command: string; opened: boolean }
  | { kind: "completed"; data: StartStatus }
  | { kind: "error"; error: SwampError };

/**
 * Checks sign-in and the harness binary, then enrols the harness in the
 * workspace (refreshing its instruction file and skills when it is already
 * enrolled). Shared by launch and resume.
 */
async function prepareHarness(
  deps: StartDeps,
  session: StartSession,
): Promise<{
  harness: NonNullable<ReturnType<typeof findHarness>>;
  binaryPath: string;
  signedIn: SignedInState;
}> {
  const signedIn = await requireSignedIn(deps, "before launching");
  const harness = session.harness ? findHarness(session.harness) : undefined;
  if (!harness) throw new UserError("Choose an agent first.");
  const binaryPath = await resolveHarnessBinary(deps, harness.binary);
  if (!binaryPath) {
    throw new UserError(
      `${harness.displayName} (\`${harness.binary}\`) is no longer on your PATH. Install it again, or start a new task with another agent.`,
    );
  }
  return { harness, binaryPath, signedIn };
}

/**
 * Sets the workspace up for the session's tools, keeping every tool it is
 * already set up for: `repo upgrade --tool` with the union. Never removes a
 * tool. Re-setting an unchanged list refreshes the instruction files and
 * skills for this version.
 */
async function enrol(
  deps: StartDeps,
  workspacePath: string,
  session: StartSession,
): Promise<void> {
  const enrolled = await deps.repo.enrolledTools(workspacePath);
  const wanted = session.tools.map((id) => findHarness(id)?.enrolTool ?? id);
  await deps.repo.setTools(workspacePath, [
    ...enrolled,
    ...wanted.filter((t) => !enrolled.includes(t)),
  ]);
}

/**
 * Refuses to go on when the task's brief path holds a file swamp did not
 * write: it is someone's own file and is never overwritten.
 *
 * @throws {UserError} code `task_file_exists`
 */
async function assertBriefIsOurs(
  deps: StartDeps,
  workspacePath: string,
  briefFile: string,
): Promise<void> {
  const text = await (deps.readBrief ?? readBriefFile)(
    workspacePath,
    briefFile,
  );
  if (text !== null && !isSwampBrief(text)) {
    const path = briefPath(workspacePath, briefFile);
    throw markErrorPaths(
      new UserError(
        `This workspace already has a file at ${briefFile} (${path}), which Swamp didn't write and won't overwrite. Rename it, then launch again.`,
        "task_file_exists",
      ),
      [path],
    );
  }
}

async function readBriefFile(
  workspacePath: string,
  briefFile: string,
): Promise<string | null> {
  try {
    return await Deno.readTextFile(briefPath(workspacePath, briefFile));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

/**
 * Enrols the chosen harness, writes the task's brief and the launcher, and
 * opens the agent's window, telling it to read that brief. Every step is
 * idempotent, so "Launch again" runs the same path.
 */
export async function* startLaunch(
  _ctx: LibSwampContext,
  deps: StartDeps,
  input: { workspacePath: string; taskId: string },
): AsyncIterable<StartLaunchEvent> {
  try {
    yield { kind: "checking" };
    const session = await loadTask(deps, input.workspacePath, input.taskId);
    session.assertCanLaunch();
    const { harness, binaryPath, signedIn } = await prepareHarness(
      deps,
      session,
    );
    // A task migrated without a brief gets its path now.
    if (session.briefFile === undefined) {
      session.assignBriefFile(
        await deps.sessions.reserveBriefFile(
          input.workspacePath,
          session.createdAt,
          session.task!.title(),
        ),
      );
    }
    const briefFile = session.briefFile!;
    // Checked before anything is set up, so a refused launch changes nothing.
    await assertBriefIsOurs(deps, input.workspacePath, briefFile);
    // The launch request carries the trust screen's confirmation.
    await requireTrust(deps, input.workspacePath, true);

    yield { kind: "enrolling", tool: session.tools.join(", ") };
    await enrol(deps, input.workspacePath, session);

    await deps.writeBrief(
      input.workspacePath,
      briefFile,
      renderBrief({
        task: session.task!,
        workspacePath: input.workspacePath,
        harnessDisplayName: harness.displayName,
        imported: isImported(deps, input.workspacePath),
      }),
    );
    yield {
      kind: "brief_written",
      path: briefPath(input.workspacePath, briefFile),
    };

    yield { kind: "window_opening" };
    const outcome = await deps.terminalLauncher.open(
      planHarnessLaunch(
        harness,
        binaryPath,
        input.workspacePath,
        deps.os,
        "task",
        briefFile,
      ),
      input.workspacePath,
    );
    session.confirmTrustAndRecordLaunch(outcome, deps.now());
    await saveLaunch(deps, session);
    yield {
      kind: "launched",
      method: outcome.method,
      command: outcome.command,
      opened: outcome.opened,
    };
    yield {
      kind: "completed",
      data: await statusOf(deps, input.workspacePath, session, signedIn),
    };
  } catch (error) {
    yield errorEvent(error);
  }
}

/**
 * Reopens a launched task's agent in its workspace, without sending the
 * task again: harnesses that can continue their most recent conversation in
 * the folder do so, the rest open a fresh session there. The brief is left
 * as it is.
 */
export async function* startResume(
  _ctx: LibSwampContext,
  deps: StartDeps,
  input: { workspacePath: string; taskId: string; trustConfirmed?: boolean },
): AsyncIterable<StartLaunchEvent> {
  try {
    yield { kind: "checking" };
    const session = await loadTask(deps, input.workspacePath, input.taskId);
    if (session.step !== "launched") {
      throw new UserError("This task hasn't been launched yet.");
    }
    const { harness, binaryPath, signedIn } = await prepareHarness(
      deps,
      session,
    );
    await requireTrust(
      deps,
      input.workspacePath,
      input.trustConfirmed === true,
    );

    yield { kind: "enrolling", tool: session.tools.join(", ") };
    await enrol(deps, input.workspacePath, session);

    yield { kind: "window_opening" };
    const outcome = await deps.terminalLauncher.open(
      planHarnessLaunch(
        harness,
        binaryPath,
        input.workspacePath,
        deps.os,
        "resume",
      ),
      input.workspacePath,
    );
    session.confirmTrustAndRecordLaunch(outcome, deps.now());
    await saveLaunch(deps, session);
    yield {
      kind: "launched",
      method: outcome.method,
      command: outcome.command,
      opened: outcome.opened,
    };
    yield {
      kind: "completed",
      data: await statusOf(deps, input.workspacePath, session, signedIn),
    };
  } catch (error) {
    yield errorEvent(error);
  }
}

/** The task the page has open, or null; a missing one reads as none. */
async function openTask(
  deps: StartDeps,
  workspacePath: string,
  taskId: string | undefined,
): Promise<StartSession | null> {
  return taskId === undefined
    ? null
    : await deps.sessions.load(workspacePath, taskId);
}

/** Sets the workspace up for more agents; never removes one. */
export function startAddTools(
  _ctx: LibSwampContext,
  deps: StartDeps,
  input: { workspacePath: string; taskId?: string; tools: readonly string[] },
): AsyncIterable<StartStatusEvent> {
  return (async function* () {
    try {
      await requireSignedIn(deps);
      const wanted = input.tools.map((id) => {
        const tool = findHarness(id);
        if (!tool) throw new UserError(`Unknown agent "${id}".`);
        return tool.enrolTool;
      });
      const enrolled = await deps.repo.enrolledTools(input.workspacePath);
      const added = wanted.filter((t) => !enrolled.includes(t));
      if (added.length > 0) {
        await deps.repo.setTools(input.workspacePath, [
          ...enrolled,
          ...new Set(added),
        ]);
      }
      yield {
        kind: "completed",
        data: await statusOf(
          deps,
          input.workspacePath,
          await openTask(deps, input.workspacePath, input.taskId),
        ),
      };
    } catch (error) {
      yield errorEvent(error);
    }
  })();
}

/**
 * Opens an agent in the workspace without a task: any installed agent, not
 * only one a task was launched with. It is set up first when needed. An
 * agent that was launched in this workspace before, and can, continues its
 * own earlier conversation; otherwise a fresh session opens.
 */
export async function* startOpenAgent(
  _ctx: LibSwampContext,
  deps: StartDeps,
  input: {
    workspacePath: string;
    taskId?: string;
    harness: string;
    trustConfirmed?: boolean;
  },
): AsyncIterable<StartLaunchEvent> {
  try {
    yield { kind: "checking" };
    const signedIn = await requireSignedIn(deps, "before opening an agent");
    const harness = findHarness(input.harness);
    if (!harness) throw new UserError(`Unknown agent "${input.harness}".`);
    if (!harness.launchable) {
      throw new UserError(
        `${harness.displayName} can't be started from Swamp yet.`,
      );
    }
    const binaryPath = await resolveHarnessBinary(deps, harness.binary);
    if (!binaryPath) {
      throw new UserError(
        `${harness.displayName} (\`${harness.binary}\`) isn't on your PATH.`,
      );
    }
    await requireTrust(
      deps,
      input.workspacePath,
      input.trustConfirmed === true,
    );

    yield { kind: "enrolling", tool: harness.enrolTool };
    const enrolled = await deps.repo.enrolledTools(input.workspacePath);
    if (!enrolled.includes(harness.enrolTool)) {
      await deps.repo.setTools(input.workspacePath, [
        ...enrolled,
        harness.enrolTool,
      ]);
    }

    const usedHere = (await deps.sessions.list(input.workspacePath)).some((
      s,
    ) => s.harness === harness.id && s.launch !== undefined);

    yield { kind: "window_opening" };
    const outcome = await deps.terminalLauncher.open(
      planHarnessLaunch(
        harness,
        binaryPath,
        input.workspacePath,
        deps.os,
        usedHere && canResume(harness) ? "resume" : "open",
      ),
      input.workspacePath,
    );
    yield {
      kind: "launched",
      method: outcome.method,
      command: outcome.command,
      opened: outcome.opened,
    };
    yield {
      kind: "completed",
      data: await statusOf(
        deps,
        input.workspacePath,
        await openTask(deps, input.workspacePath, input.taskId),
        signedIn,
      ),
    };
  } catch (error) {
    yield errorEvent(error);
  }
}

// ---------------------------------------------------------------------------
// Inspect (JSON mode and `start status`)
// ---------------------------------------------------------------------------

/** What `swamp start --json` and `swamp start status` print. */
export interface StartInspection {
  readonly signedIn: "signed_in" | "not_signed_in" | "blocked" | "unknown";
  /** The signed-in account's username, when known. */
  readonly username?: string;
  /** Why the account couldn't be verified (signedIn "blocked"). */
  readonly blockedReason?: string;
  /** Every workspace, or only the one named with `--workspace`. */
  readonly workspaces: StartWorkspaceSummary[];
  /** Every supported harness and whether it is on PATH. */
  readonly agents: StartHarnessInfo[];
}

/** Reads the workspaces' state without creating anything or calling out. */
export async function startInspect(
  ctx: LibSwampContext,
  deps: StartDeps,
  input: { workspaceName?: string },
): Promise<StartInspection> {
  let signedIn: StartInspection["signedIn"];
  let account: { username?: string; blockedReason?: string } = {};
  try {
    const state = await deps.checkSignedIn(false);
    signedIn = state.kind;
    if (state.kind === "signed_in" && state.username) {
      account = { username: state.username };
    } else if (state.kind === "blocked") {
      account = { blockedReason: state.reason };
    }
  } catch {
    signedIn = "unknown";
  }
  const { workspaces } = await startListWorkspaces(ctx, deps, {
    readOnly: true,
  });
  const wanted = input.workspaceName === undefined
    ? workspaces
    : workspaces.filter((w) =>
      w.name === parseWorkspaceName(input.workspaceName!)
    );
  return {
    signedIn,
    ...account,
    workspaces: wanted,
    agents: await startListHarnesses(ctx, deps),
  };
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/** Checks the chooser's availability once per process. */
function memoizedAvailability(picker: FolderPicker): FolderPicker {
  let available: Promise<boolean> | undefined;
  return {
    available: () => available ??= picker.available(),
    pick: (prompt) => picker.pick(prompt),
  };
}

const NO_SIGNALS: StartSignals = {
  kubeconfig: false,
  awsConfig: false,
  gcloudAdc: false,
};

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Real dependencies; the CLI supplies the sign-in check. */
export function createStartDeps(options: {
  version: string;
  checkSignedIn: (live: boolean) => Promise<SignedInState>;
  serverUrl: string;
  identity?: ClientIdentity;
  lookup?: (name: string) => Promise<string[]>;
  homeDir?: string;
  /** True when another `swamp start` serves the workspace. */
  isRunning: (workspacePath: string) => Promise<boolean>;
}): StartDeps {
  const service = new RepoService(options.version);
  const markers = new RepoMarkerRepository();
  const home = options.homeDir ?? Deno.env.get("HOME") ??
    Deno.env.get("USERPROFILE") ?? "";
  const loginDeps: AuthLoginDeps = {
    ...createAuthLoginDeps(options.identity),
    // The page opens the verification URL itself.
    openBrowser: () => Promise.resolve(true),
  };
  return {
    dataDir: getSwampDataDir(),
    os: Deno.build.os,
    checkSignedIn: options.checkSignedIn,
    apiKeyFromEnv: () => apiKeySourceName() !== undefined,
    repo: {
      isRepo: (path) => exists(join(path, ".swamp.yaml")),
      init: async (path) => {
        await service.init(RepoPath.create(path), { tools: [] });
      },
      enrolledTools: async (path) =>
        (await markers.read(RepoPath.create(path)))?.tools ?? [],
      createdAt: async (path) =>
        (await markers.read(RepoPath.create(path)))?.initializedAt ?? null,
      setTools: async (path, tools) => {
        await service.upgrade(RepoPath.create(path), {
          tools,
          lockfilePath: null,
        });
      },
    },
    sessions: new StartSessionFileRepository(),
    lookup: options.lookup ?? lookupExecutable,
    terminalLauncher: createSystemTerminalLauncher(),
    folderPicker: memoizedAvailability(createSystemFolderPicker()),
    // Written to a temporary file and renamed into place, so a symlink
    // planted at the brief's path is replaced, never followed; a symlinked
    // `tasks/` folder is refused.
    writeBrief: async (workspacePath, briefFile, content) => {
      await refuseSymlinks(startWritePaths(workspacePath));
      await ensureDir(join(workspacePath, "tasks"));
      await atomicWriteTextFile(
        briefPath(workspacePath, briefFile),
        content,
        { mode: 0o600 },
      );
    },
    // With no home folder there is nothing to look for; a relative path
    // would read the current directory instead.
    signals: async () =>
      home === "" ? NO_SIGNALS : ({
        kubeconfig: await exists(join(home, ".kube", "config")),
        awsConfig: await exists(join(home, ".aws", "config")) ||
          await exists(join(home, ".aws", "credentials")),
        gcloudAdc: await exists(
          join(
            home,
            ".config",
            "gcloud",
            "application_default_credentials.json",
          ),
        ),
      }),
    signIn: (ctx) =>
      authLogin(ctx, loginDeps, {
        serverUrl: options.serverUrl,
        useBrowserFlow: true,
      }),
    now: () => new Date(),
    randomUUID: () => crypto.randomUUID(),
    random: () => Math.random(),
    isRunning: options.isRunning,
    registry: new WorkspaceRegistryFileRepository(),
    ...(home ? { homeDir: home } : {}),
  };
}
