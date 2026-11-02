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
import { basename, join } from "@std/path";
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
} from "../../domain/workspace/workspace_name.ts";
import type {
  WorkspaceEntry,
  WorkspaceRegistryRepository,
} from "../../domain/workspace/workspace_registry.ts";
import {
  checkNewWorkspaceFolder,
  createNewWorkspace,
  defaultWorkspaceParent,
  defaultWorkspacePath,
  ensureRegistered,
  ensureWorkspace,
  importableFolder,
  importWorkspace,
  isImportedWorkspace,
  loadWorkspaceRegistry,
  newWorkspaceLocation,
  realPathOrSelf,
  workspacesRoot,
} from "../workspace/workspace_store.ts";
import { WorkspacePreferencesFileRepository } from "../../infrastructure/persistence/workspace_preferences_file_repository.ts";
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

export { expandHome } from "../workspace/workspace_store.ts";

export type SignedInState =
  | {
    readonly kind: "signed_in";
    readonly username?: string;
    readonly source: "file" | "api_key";
  }
  | { readonly kind: "not_signed_in" }
  | { readonly kind: "blocked"; readonly reason: string };

export type StartScreen =
  | "workspace"
  | "task"
  | "sign_in"
  | "blocked"
  | "agent"
  | "trust"
  | "launched"
  | "home";

export interface StartSignals {
  readonly kubeconfig: boolean;
  readonly awsConfig: boolean;
  readonly gcloudAdc: boolean;
}

/** Everything the start page renders from. Never carries a secret. */
export interface StartStatus {
  readonly workspacePath: string | null;
  readonly workspaceName: string | null;
  readonly signedIn: "signed_in" | "not_signed_in" | "blocked";
  readonly username?: string;
  readonly blockedReason?: string;
  readonly screen: StartScreen;
  readonly taskId?: string;
  readonly task?: {
    readonly text: string;
    readonly title: string;
    readonly createdAt: string;
    readonly briefFile?: string;
  };
  readonly harness?: {
    readonly id: string;
    readonly displayName: string;
    readonly trustMode: TrustMode;
    readonly canResume: boolean;
  };
  readonly launch?: {
    readonly method: LaunchMethod;
    readonly command: string;
    readonly opened: boolean;
    readonly at: string;
  };
  readonly contents?: StartContents;
  readonly enrolledTools?: readonly string[];
  readonly tools?: readonly string[];
  readonly alsoOpenElsewhere?: boolean;
  readonly tasks?: readonly StartTaskSummary[];
  /**
   * recorded in the workspace registry on this machine, never read from the
   * workspace; until set, every agent launch asks for confirmation
   */
  readonly trusted: boolean;
  readonly lastAgent?: string;
  readonly canPickFolder: boolean;
  readonly apiKeyFromEnv: boolean;
  readonly signals: StartSignals;
}

export interface StartContents {
  readonly models: number;
  readonly workflows: number;
  readonly modelList: readonly {
    readonly name: string;
    readonly type: string;
  }[];
  readonly workflowList: readonly string[];
}

const CONTENTS_LIMIT = 8;

export interface StartHarnessInfo {
  readonly id: string;
  readonly displayName: string;
  readonly binary: string;
  readonly binaryPath: string | null;
  readonly found: boolean;
  readonly trustMode: TrustMode;
  readonly launchable: boolean;
}

export interface StartWorkspaceSummary {
  readonly name: string;
  readonly path: string;
  readonly step: StartSession["step"] | null;
  readonly taskTitle: string | null;
  readonly harness: string | null;
  readonly harnessDisplayName: string | null;
  readonly tasks: readonly StartTaskSummary[];
  readonly enrolledTools: readonly string[];
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly running: boolean;
  readonly imported: boolean;
}

export interface StartRepoOps {
  isRepo(path: string): Promise<boolean>;
  init(path: string): Promise<void>;
  enrolledTools(path: string): Promise<string[]>;
  createdAt?(path: string): Promise<string | null>;
  setTools(path: string, tools: string[]): Promise<void>;
}

export interface StartDeps {
  readonly dataDir: string;
  readonly os: string;
  readonly checkSignedIn: (live: boolean) => Promise<SignedInState>;
  readonly apiKeyFromEnv: () => boolean;
  readonly repo: StartRepoOps;
  readonly sessions: StartSessionRepository;
  readonly lookup: (name: string) => Promise<string[]>;
  readonly terminalLauncher: TerminalLauncher;
  readonly writeBrief: (
    workspacePath: string,
    briefFile: string,
    content: string,
  ) => Promise<void>;
  readonly signals: () => Promise<StartSignals>;
  readonly signIn: (ctx: LibSwampContext) => AsyncIterable<AuthLoginEvent>;
  readonly now: () => Date;
  readonly randomUUID: () => string;
  readonly random: () => number;
  readonly isRunning: (workspacePath: string) => Promise<boolean>;
  readonly registry: WorkspaceRegistryRepository;
  readonly homeDir?: string;
  readonly configuredParent?: () => Promise<string | undefined>;
  readonly readBrief?: (
    workspacePath: string,
    briefFile: string,
  ) => Promise<string | null>;
  readonly folderPicker?: FolderPicker;
}

/**
 * every workspace write needs sign-in; `swamp start` is exempt from the auth
 * gate only so it can sign the user in
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

export function startWorkspacePath(dataDir: string, name: string): string {
  return defaultWorkspacePath(dataDir, name);
}

export async function resolveStartWorkspacePath(
  deps: StartDeps,
  name: string,
  location: StartWorkspaceLocationInput = {},
): Promise<string> {
  let parsed: string;
  let registered: string | undefined;
  try {
    parsed = parseWorkspaceName(name);
    // Only a lookup: opening the workspace registers it, after sign-in.
    registered = (await loadWorkspaceRegistry(deps, { readOnly: true }))
      .get(parsed)?.path;
  } catch (error) {
    throw asInvalidName(error);
  }
  if (registered !== undefined) return registered;
  return (await newWorkspaceLocation(deps, { name: parsed, ...location }))
    .path;
}

function deriveScreen(
  session: StartSession | null,
  signedIn: SignedInState,
): StartScreen {
  if (signedIn.kind === "blocked") return "blocked";
  if (signedIn.kind === "not_signed_in") return "sign_in";
  return session?.step ?? "task";
}

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

export interface StartTaskSummary {
  readonly id: string;
  readonly title: string;
  readonly step: StartSession["step"];
  readonly harness: string | null;
  readonly harnessDisplayName: string | null;
  readonly createdAt: string;
  readonly launchedAt: string | null;
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
 * trust is recorded in the workspace registry, never taken from the workspace's
 * own files: an imported repo can carry a state.json claiming its task was
 * launched
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
    await loadWorkspaceRegistry(deps);
    await deps.registry.update((registry) =>
      registry.rememberAgent(harness.id)
    );
  });
}

export async function startListTasks(
  _ctx: LibSwampContext,
  deps: StartDeps,
  input: { workspacePath: string },
): Promise<StartTaskSummary[]> {
  return await listTasks(deps, input.workspacePath);
}

export type StartPrepareEvent =
  | { kind: "signed_in_checked"; state: SignedInState }
  | { kind: "workspace_ready"; path: string; created: boolean }
  | { kind: "completed"; data: StartStatus }
  | { kind: "error"; error: SwampError };

/**
 * a failed save is only a warning: the agent is already running, and reporting
 * failure would invite a second agent on the same brief
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

export interface StartWorkspaceLocationInput {
  readonly parent?: string;
  readonly relativeTo?: string;
}

/**
 * the caller holds the workspace's claim (creation lock and server record);
 * several `swamp start` processes may serve one workspace
 */
export function startOpenWorkspace(
  _ctx: LibSwampContext,
  deps: StartDeps,
  input: { workspaceName: string } & StartWorkspaceLocationInput,
): AsyncIterable<StartPrepareEvent> {
  return openWorkspace(deps, input.workspaceName, undefined, input);
}

async function isImportedFolder(
  deps: StartDeps,
  path: string,
): Promise<boolean> {
  // Matched by real path: the launch may spell the folder differently
  // (/tmp vs /private/tmp) from how it was registered.
  const real = await realPathOrSelf(path);
  let entry: WorkspaceEntry | undefined;
  for (
    const e of (await loadWorkspaceRegistry(deps, { readOnly: true })).list()
  ) {
    if (e.path === path || await realPathOrSelf(e.path) === real) {
      entry = e;
      break;
    }
  }
  return isImportedWorkspace(deps.dataDir, entry ?? { path });
}

function asInvalidName(error: unknown): unknown {
  if (error instanceof UserError && error.code !== "registry_unreadable") {
    return new UserError(error.message, "invalid_name");
  }
  return error;
}

async function* openWorkspace(
  deps: StartDeps,
  workspaceName: string,
  checked?: SignedInState,
  location: StartWorkspaceLocationInput = {},
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
    let registered: string | undefined;
    try {
      name = parseWorkspaceName(workspaceName);
      // Only a lookup: opening the workspace registers it, after sign-in.
      registered = (await loadWorkspaceRegistry(deps, { readOnly: true }))
        .get(name)?.path;
    } catch (error) {
      throw asInvalidName(error);
    }
    const wanted = registered === undefined
      ? await newWorkspaceLocation(deps, { name, ...location })
      : null;
    let workspacePath: string;
    let created: boolean;
    if (registered !== undefined) {
      await refuseOtherFolder(deps, name, registered, location);
      workspacePath = registered;
      created = await ensureWorkspace(deps, name, workspacePath);
      // A name adopted from the data dir is only listed until now.
      await ensureRegistered(deps, name, workspacePath);
    } else if (wanted!.inDataDir) {
      workspacePath = wanted!.path;
      created = await ensureWorkspace(deps, name, workspacePath);
      await ensureRegistered(deps, name, workspacePath);
    } else {
      workspacePath = wanted!.path;
      await createNewWorkspace(deps, wanted!);
      created = true;
    }
    await migrateLegacyTasks(deps, workspacePath);
    yield { kind: "workspace_ready", path: workspacePath, created };
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

async function refuseOtherFolder(
  deps: StartDeps,
  name: string,
  registered: string,
  location: StartWorkspaceLocationInput,
): Promise<void> {
  if (!location.parent?.trim()) return;
  try {
    const wanted = await newWorkspaceLocation(deps, { name, ...location });
    if (
      await realPathOrSelf(wanted.path) === await realPathOrSelf(registered)
    ) {
      return;
    }
  } catch (error) {
    // A folder that can't be used still names a different place.
    if (!(error instanceof UserError)) throw error;
  }
  throw markErrorPaths(
    new UserError(
      `A workspace named "${name}" already exists at ${registered}. Choose another name.`,
      "name_taken",
    ),
    [registered],
  );
}

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

async function mtimeOf(path: string): Promise<Date | null> {
  try {
    return (await Deno.stat(path)).mtime;
  } catch {
    return null;
  }
}

export async function startListWorkspaces(
  _ctx: LibSwampContext,
  deps: StartDeps,
  options: { readOnly?: boolean } = {},
): Promise<{
  workspaces: StartWorkspaceSummary[];
  suggestedName: string;
  defaultLocation: string;
}> {
  const defaultLocation = await defaultWorkspaceParent(deps);
  const registry = await loadWorkspaceRegistry(deps, options);
  // Folder names under the data dir and the default folder count as taken
  // too, so a suggestion never collides with a folder that isn't
  // registered.
  const taken = new Set(registry.list().map((e) => e.name));
  const root = workspacesRoot(deps.dataDir);
  for (const dir of new Set([root, defaultLocation])) {
    try {
      for await (const entry of Deno.readDir(dir)) {
        if (entry.isDirectory) taken.add(entry.name);
      }
    } catch (error) {
      // The configured folder only feeds the suggestion: one that has
      // become unreadable or a file never hides the workspace list (a
      // create there reports the problem).
      if (dir !== root) continue;
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  const summaries = await Promise.all(
    registry.list().map((entry) =>
      // One workspace that can't be read (a damaged `.swamp.yaml` or
      // session file) is left out rather than hiding all the others.
      summarize(entry).catch(() => null)
    ),
  );
  async function summarize(
    entry: WorkspaceEntry,
  ): Promise<StartWorkspaceSummary | null> {
    const { name, path } = entry;
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
      imported: isImportedWorkspace(deps.dataDir, entry),
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
    defaultLocation,
  };
}

export type StartLocationCheck =
  | {
    readonly ok: true;
    readonly path: string;
  }
  | {
    readonly ok: false;
    readonly field: "name" | "location";
    readonly code: string;
    readonly message: string;
    readonly path?: string;
  };

const NAME_PROBLEMS = new Set(["invalid_name", "name_taken"]);

export async function startCheckWorkspaceLocation(
  _ctx: LibSwampContext,
  deps: StartDeps,
  input: { name: string; parent?: string },
): Promise<StartLocationCheck> {
  await requireSignedIn(deps, "before you create a workspace");
  let path: string | undefined;
  try {
    const location = await newWorkspaceLocation(deps, input);
    path = location.path;
    await checkNewWorkspaceFolder(
      deps,
      await loadWorkspaceRegistry(deps, { readOnly: true }),
      location,
      // Opening reuses a repo left under the data dir; the check agrees.
      { reuseRepo: location.inDataDir },
    );
    return { ok: true, path };
  } catch (error) {
    if (!(error instanceof UserError) || error.code === undefined) throw error;
    if (error.code === "registry_unreadable") throw error;
    return {
      ok: false,
      field: NAME_PROBLEMS.has(error.code) ? "name" : "location",
      code: error.code,
      message: error.message,
      ...(path !== undefined ? { path } : {}),
    };
  }
}

export const PICK_FOLDER_PROMPT = "Choose the swamp repo to import";

export const PICK_LOCATION_PROMPT = "Choose where to create the workspace";

export async function startPickFolder(
  _ctx: LibSwampContext,
  deps: StartDeps,
  input: { purpose?: "import" | "location" } = {},
): Promise<{ path: string | null }> {
  const forLocation = input.purpose === "location";
  await requireSignedIn(
    deps,
    forLocation
      ? "before you create a workspace"
      : "before importing a workspace",
  );
  if (!await canPickFolder(deps)) {
    throw new UserError(
      "This machine can't show a folder chooser here. Type the folder's path instead.",
      "picker_unavailable",
    );
  }
  return {
    path: await deps.folderPicker!.pick(
      forLocation ? PICK_LOCATION_PROMPT : PICK_FOLDER_PROMPT,
    ),
  };
}

export type StartFolderCheck =
  | {
    readonly ok: true;
    readonly path: string;
    readonly registeredAs?: string;
  }
  | {
    readonly ok: false;
    readonly code: "not_found" | "not_a_repo";
    readonly message: string;
  };

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
  const registry = await loadWorkspaceRegistry(deps, { readOnly: true });
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
  const { name, path } = await importWorkspace(deps, input);
  return { name, path };
}

async function resolveHarnessBinary(
  deps: StartDeps,
  binary: string,
): Promise<string | null> {
  return pickBinaryPath(await deps.lookup(binary), deps.os);
}

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

export type StartLaunchEvent =
  | { kind: "checking" }
  | { kind: "enrolling"; tool: string }
  | { kind: "brief_written"; path: string }
  | { kind: "window_opening" }
  | { kind: "launched"; method: LaunchMethod; command: string; opened: boolean }
  | { kind: "completed"; data: StartStatus }
  | { kind: "error"; error: SwampError };

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
 * sets up the union of the workspace's tools and the session's; never removes a
 * tool
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
 * a file at the brief path that swamp did not write is someone's own and is
 * never overwritten
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

/** every step is idempotent, so launching again runs the same path */
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
        imported: await isImportedFolder(deps, input.workspacePath),
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

async function openTask(
  deps: StartDeps,
  workspacePath: string,
  taskId: string | undefined,
): Promise<StartSession | null> {
  return taskId === undefined
    ? null
    : await deps.sessions.load(workspacePath, taskId);
}

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

export interface StartInspection {
  readonly signedIn: "signed_in" | "not_signed_in" | "blocked" | "unknown";
  readonly username?: string;
  readonly blockedReason?: string;
  readonly workspaces: StartWorkspaceSummary[];
  readonly agents: StartHarnessInfo[];
}

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

export function createStartDeps(options: {
  version: string;
  checkSignedIn: (live: boolean) => Promise<SignedInState>;
  serverUrl: string;
  identity?: ClientIdentity;
  lookup?: (name: string) => Promise<string[]>;
  homeDir?: string;
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
    configuredParent: async () =>
      (await new WorkspacePreferencesFileRepository().read()).dir,
    ...(home ? { homeDir: home } : {}),
  };
}
