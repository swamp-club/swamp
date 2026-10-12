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

/** How a harness handles the "do you trust this folder?" question. */
export type TrustMode = "dialog" | "passed" | "unknown";

/** How `swamp start` launched the harness. */
export type LaunchMethod =
  | "macos_terminal"
  | "windows_terminal"
  | "linux_terminal"
  | "copy_command";

/** The screens the start server can put the page on. */
export type StartScreen =
  | "workspace"
  | "task"
  | "sign_in"
  | "blocked"
  | "agent"
  | "trust"
  | "launched"
  /** The workspace's home: every task, and the open one's summary. */
  | "home";

/** Local credential files that only order the example prompts. */
export interface StartSignals {
  kubeconfig: boolean;
  awsConfig: boolean;
  gcloudAdc: boolean;
}

/** The status object every `start.*` request (bar a few) replies with. */
export interface StartStatus {
  /** Null while no workspace is bound (`screen === "workspace"`). */
  workspacePath: string | null;
  workspaceName: string | null;
  signedIn: "signed_in" | "not_signed_in" | "blocked";
  username?: string;
  blockedReason?: string;
  screen: StartScreen;
  /** The task the page has open; none while a new task is written. */
  taskId?: string;
  task?: {
    text: string;
    title: string;
    /** ISO time the task was created. */
    createdAt?: string;
    /** Its brief, relative to the workspace (`tasks/<name>.md`). */
    briefFile?: string;
  };
  harness?: {
    id: string;
    displayName: string;
    trustMode: TrustMode;
    /**
     * True when reopening the agent continues its previous conversation;
     * false when a fresh session opens in the workspace.
     */
    canResume: boolean;
  };
  launch?: {
    method: LaunchMethod;
    command: string;
    opened: boolean;
    /** ISO time of the last launch. */
    at: string;
  };
  /** Tools the workspace is already set up for, from its `.swamp.yaml`. */
  enrolledTools: string[];
  /** Every tool chosen for this task, the harness included. */
  tools?: string[];
  /** The definitions in the workspace now. */
  contents?: {
    models: number;
    workflows: number;
    modelList?: { name: string; type: string }[];
    workflowList?: string[];
  };
  apiKeyFromEnv: boolean;
  signals: StartSignals;
  /** True when another swamp start has this workspace open too. */
  alsoOpenElsewhere?: boolean;
  /** Every task of the workspace, newest first. */
  tasks?: TaskSummary[];
  /**
   * True once the user confirmed, on this machine, that agents may work in
   * the workspace. Until then opening an agent asks for that confirmation.
   */
  trusted: boolean;
  /**
   * True when the server can show this machine's folder chooser for an
   * import (not over SSH or without a display).
   */
  canPickFolder?: boolean;
}

/** The step a workspace's saved session has reached. */
export type WorkspaceStep = "task" | "agent" | "trust" | "launched";

/** How far a task has got. */
export type TaskStep = "task" | "agent" | "trust" | "launched";

/** One task in the workspace, as `start.tasks.list` reports it. */
export interface TaskSummary {
  id: string;
  title: string;
  step: TaskStep;
  harness: string | null;
  harnessDisplayName: string | null;
  /** ISO time the task was created; the list is ordered by it. */
  createdAt: string;
  launchedAt: string | null;
  /** Its brief, relative to the workspace, once it has one. */
  briefFile?: string | null;
}

/** The reply to `start.tasks.list`, newest first by creation. */
export interface TaskList {
  tasks: TaskSummary[];
}

/** One existing workspace, as `start.workspaces.list` reports it. */
export interface WorkspaceSummary {
  name: string;
  path: string;
  step: WorkspaceStep | null;
  taskTitle: string | null;
  harness: string | null;
  harnessDisplayName: string | null;
  /** Tools the workspace is set up for. */
  enrolledTools?: string[];
  /** When the workspace was created. */
  createdAt?: string | null;
  updatedAt: string | null;
  /** True when another `swamp start` has this workspace open. */
  running: boolean;
  /** True when the workspace's folder is outside `~/.swamp/workspaces`. */
  imported: boolean;
}

/** The reply to `start.workspaces.list`. */
export interface WorkspaceList {
  workspaces: WorkspaceSummary[];
  suggestedName: string;
}

/** One agent harness swamp supports, found on this machine or not. */
export interface StartHarness {
  id: string;
  displayName: string;
  /** The executable swamp looks for on the PATH. */
  binary: string;
  binaryPath: string | null;
  found: boolean;
  trustMode: TrustMode;
  launchable: boolean;
}

/** The reply to `start.harness.list`. */
export interface HarnessList {
  harnesses: StartHarness[];
}

/** Events streamed by `start.signin`. */
export type SigninEvent =
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

/**
 * Events streamed by `start.launch`. `start.resume` and `start.agent.open`
 * stream the same ones bar `brief_written`.
 */
export type LaunchEvent =
  | { kind: "checking" }
  | { kind: "enrolling" }
  | { kind: "brief_written" }
  | { kind: "window_opening" }
  | {
    kind: "launched";
    method: LaunchMethod;
    command: string;
    /** Sent by `start.agent.open`: false when no window opened. */
    opened?: boolean;
  }
  | { kind: "error"; message: string };

/** An example task offered on the task screen. */
export interface ExamplePrompt {
  id: string;
  /** The local signal that makes this example more relevant, if any. */
  signal?: keyof StartSignals;
  text: string;
}
