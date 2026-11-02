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

export type TrustMode = "dialog" | "passed" | "unknown";

export type LaunchMethod =
  | "macos_terminal"
  | "windows_terminal"
  | "linux_terminal"
  | "copy_command";

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
  kubeconfig: boolean;
  awsConfig: boolean;
  gcloudAdc: boolean;
}

export interface StartStatus {
  workspacePath: string | null;
  workspaceName: string | null;
  signedIn: "signed_in" | "not_signed_in" | "blocked";
  username?: string;
  blockedReason?: string;
  screen: StartScreen;
  taskId?: string;
  task?: {
    text: string;
    title: string;
    createdAt?: string;
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
    at: string;
  };
  enrolledTools: string[];
  tools?: string[];
  contents?: {
    models: number;
    workflows: number;
    modelList?: { name: string; type: string }[];
    workflowList?: string[];
  };
  apiKeyFromEnv: boolean;
  signals: StartSignals;
  alsoOpenElsewhere?: boolean;
  tasks?: TaskSummary[];
  /**
   * True once the user confirmed, on this machine, that agents may work in
   * the workspace. Until then opening an agent asks for that confirmation.
   */
  trusted: boolean;
  lastAgent?: string;
  canPickFolder?: boolean;
}

export type WorkspaceStep = "task" | "agent" | "trust" | "launched";

export type TaskStep = "task" | "agent" | "trust" | "launched";

export interface TaskSummary {
  id: string;
  title: string;
  step: TaskStep;
  harness: string | null;
  harnessDisplayName: string | null;
  createdAt: string;
  launchedAt: string | null;
  briefFile?: string | null;
}

export interface TaskList {
  tasks: TaskSummary[];
}

export interface WorkspaceSummary {
  name: string;
  path: string;
  step: WorkspaceStep | null;
  taskTitle: string | null;
  harness: string | null;
  harnessDisplayName: string | null;
  enrolledTools?: string[];
  createdAt?: string | null;
  updatedAt: string | null;
  running: boolean;
  imported: boolean;
}

export interface WorkspaceList {
  workspaces: WorkspaceSummary[];
  suggestedName: string;
  defaultLocation?: string;
}

export interface StartHarness {
  id: string;
  displayName: string;
  binary: string;
  binaryPath: string | null;
  found: boolean;
  trustMode: TrustMode;
  launchable: boolean;
}

export interface HarnessList {
  harnesses: StartHarness[];
}

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

export type LaunchEvent =
  | { kind: "checking" }
  | { kind: "enrolling" }
  | { kind: "brief_written" }
  | { kind: "window_opening" }
  | {
    kind: "launched";
    method: LaunchMethod;
    command: string;
    opened?: boolean;
  }
  | { kind: "error"; message: string };

export interface ExamplePrompt {
  id: string;
  signal?: keyof StartSignals;
  text: string;
}
