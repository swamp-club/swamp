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

import type { DetectableAiTool } from "../telemetry/agent_harness_detection.ts";
import { markErrorPaths } from "../errors.ts";
import { isAgentSessionId } from "./agent_session.ts";
import { isBriefFile } from "./brief.ts";
import type { TrustMode } from "./start_session.ts";
import type { StartTaskKind } from "./start_task.ts";

/**
 * only a well-formed brief path is accepted, so no text the user typed reaches
 * a command line
 */
export function launchPrompt(
  briefFile: string,
  kind: StartTaskKind = "task",
): string {
  if (!isBriefFile(briefFile)) {
    throw markErrorPaths(
      new Error(`Invalid task brief path ${JSON.stringify(briefFile)}`),
      [briefFile],
    );
  }
  const skill = kind === "swampify" ? "swampify" : "swamp-getting-started";
  return `Read ${briefFile} and use the ${skill} skill.`;
}

export interface HarnessDefinition {
  readonly id: DetectableAiTool;
  readonly displayName: string;
  readonly binary: string;
  readonly enrolTool: string;
  readonly trustMode: TrustMode;
  readonly launchable: boolean;
  readonly args: (
    workspacePath: string,
    os: string,
    prompt: string,
    sessionId?: string,
  ) => readonly string[];
  readonly openArgs: (workspacePath: string, os: string) => readonly string[];
  /**
   * The arguments that continue the agent's most recent conversation in the
   * workspace folder. Absent when the harness has no verified way to do it.
   */
  readonly resumeArgs?: (
    workspacePath: string,
    os: string,
    sessionId?: string,
  ) => readonly string[];
  /** run when a resume fails at once; openArgs when absent */
  readonly resumeFallbackArgs?: (
    workspacePath: string,
    os: string,
    sessionId?: string,
  ) => readonly string[];
  /**
   * assigned: start gives the task launch its conversation id; found: the
   * agent picks one, and start looks it up at resume
   */
  readonly sessionIds?: "assigned" | "found";
}

export type LaunchMode = "task" | "resume" | "open";

export interface HarnessLaunchSpec {
  readonly harness: DetectableAiTool;
  readonly displayName: string;
  readonly binaryPath: string;
  readonly args: readonly string[];
  /**
   * run instead when args fails straight away; set for a resume, since with no
   * earlier conversation the continue flag exits non-zero, so a fresh session
   * opens instead
   */
  readonly fallbackArgs?: readonly string[];
  readonly trustMode: TrustMode;
}

/**
 * the folder is a quoted key so the dots in .swamp are not read as key
 * separators
 */
function codexTrustOverride(workspacePath: string): string {
  const escaped = workspacePath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `projects."${escaped}".trust_level="trusted"`;
}

export const HARNESSES: readonly HarnessDefinition[] = [
  {
    id: "claude",
    displayName: "Claude Code",
    binary: "claude",
    enrolTool: "claude",
    trustMode: "dialog",
    launchable: true,
    args: (_ws, _os, prompt, sessionId) =>
      sessionId === undefined ? [prompt] : ["--session-id", sessionId, prompt],
    openArgs: () => [],
    // `--continue` picks the most recent conversation in the current folder.
    resumeArgs: (_ws, _os, sessionId) =>
      sessionId === undefined ? ["--continue"] : ["--resume", sessionId],
    // A recorded conversation that never started (a copied command never run)
    // is started under the same id, so the next resume finds it.
    resumeFallbackArgs: (_ws, _os, sessionId) =>
      sessionId === undefined ? [] : ["--session-id", sessionId],
    sessionIds: "assigned",
  },
  {
    id: "codex",
    displayName: "Codex",
    binary: "codex",
    enrolTool: "codex",
    trustMode: "passed",
    launchable: true,
    // cmd cannot carry the quoted key, so Windows falls back to the dialog.
    args: (ws, os, prompt) =>
      os === "windows" ? [prompt] : ["-c", codexTrustOverride(ws), prompt],
    openArgs: (ws, os) =>
      os === "windows" ? [] : ["-c", codexTrustOverride(ws)],
    // `resume --last` is filtered to the current folder unless `--all`.
    resumeArgs: (ws, os, sessionId) => {
      const target = sessionId === undefined ? ["--last"] : [sessionId];
      return os === "windows"
        ? ["resume", ...target]
        : ["resume", ...target, "-c", codexTrustOverride(ws)];
    },
    sessionIds: "found",
  },
  {
    id: "cursor",
    displayName: "Cursor",
    binary: "cursor-agent",
    enrolTool: "cursor",
    trustMode: "passed",
    launchable: true,
    args: (_ws, _os, prompt) => ["--trust", prompt],
    openArgs: () => ["--trust"],
  },
  {
    id: "opencode",
    displayName: "OpenCode",
    binary: "opencode",
    enrolTool: "opencode",
    trustMode: "unknown",
    launchable: true,
    args: (_ws, _os, prompt) => ["--prompt", prompt],
    openArgs: () => [],
    resumeArgs: () => ["--continue"],
  },
  {
    id: "copilot",
    displayName: "Copilot",
    binary: "copilot",
    enrolTool: "copilot",
    trustMode: "unknown",
    launchable: true,
    args: (_ws, _os, prompt) => ["-i", prompt],
    openArgs: () => [],
  },
  {
    id: "kiro",
    displayName: "Kiro",
    binary: "kiro-cli",
    enrolTool: "kiro",
    trustMode: "unknown",
    launchable: true,
    args: (_ws, _os, prompt) => ["chat", "--agent", "swamp", prompt],
    openArgs: () => ["chat", "--agent", "swamp"],
  },
  {
    id: "pi",
    displayName: "Pi",
    binary: "pi",
    enrolTool: "pi",
    trustMode: "unknown",
    launchable: true,
    args: (_ws, _os, prompt) => [prompt],
    openArgs: () => [],
  },
  {
    id: "amp",
    displayName: "Amp",
    binary: "amp",
    enrolTool: "amp",
    trustMode: "unknown",
    launchable: false,
    args: () => [],
    openArgs: () => [],
  },
  {
    id: "antigravity",
    displayName: "Antigravity",
    binary: "agy",
    enrolTool: "antigravity",
    trustMode: "unknown",
    launchable: false,
    args: () => [],
    openArgs: () => [],
  },
];

export function findHarness(id: string): HarnessDefinition | undefined {
  return HARNESSES.find((h) => h.id === id);
}

/**
 * on Windows where lists the extensionless npm shim first, so prefer a .cmd or
 * .exe hit
 */
export function pickBinaryPath(
  lines: readonly string[],
  os: string,
): string | null {
  const hits = lines.map((l) => l.trim()).filter((l) => l.length > 0);
  if (hits.length === 0) return null;
  if (os !== "windows") return hits[0];
  return hits.find((h) => /\.(cmd|exe)$/i.test(h)) ?? hits[0];
}

/**
 * Codex's override cannot be carried by cmd, so on Windows Codex shows its own
 * dialog
 */
export function effectiveTrustMode(
  harness: HarnessDefinition,
  os: string,
): TrustMode {
  return harness.id === "codex" && os === "windows"
    ? "dialog"
    : harness.trustMode;
}

export function planHarnessLaunch(
  harness: HarnessDefinition,
  binaryPath: string,
  workspacePath: string,
  os: string,
  mode: LaunchMode = "task",
  briefFile?: string,
  taskKind: StartTaskKind = "task",
  sessionId?: string,
): HarnessLaunchSpec {
  const trustMode = effectiveTrustMode(harness, os);
  // Checked here as well as on read, so no caller can pass a flag through.
  const id = isAgentSessionId(sessionId) ? sessionId : undefined;
  const args = mode === "task"
    ? harness.args(
      workspacePath,
      os,
      launchPrompt(briefFile ?? "", taskKind),
      id,
    )
    : mode === "resume"
    ? (harness.resumeArgs ?? harness.openArgs)(workspacePath, os, id)
    : harness.openArgs(workspacePath, os);
  const fallbackArgs = mode === "resume" && harness.resumeArgs !== undefined
    ? harness.resumeFallbackArgs?.(workspacePath, os, id) ??
      harness.openArgs(workspacePath, os)
    : undefined;
  return {
    harness: harness.id,
    displayName: harness.displayName,
    binaryPath,
    args,
    ...(fallbackArgs !== undefined ? { fallbackArgs } : {}),
    trustMode,
  };
}

export function canResume(harness: HarnessDefinition): boolean {
  return harness.resumeArgs !== undefined;
}
