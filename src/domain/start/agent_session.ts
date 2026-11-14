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

const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Session ids reach the agent's command line, and task records can come from
 * an imported repo, so only a UUID is ever accepted: nothing dash-led can be
 * read as a flag.
 */
export function isAgentSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

/** the fields start reads from a Codex session file's first line */
export interface CodexSessionHeader {
  readonly id: string;
  readonly startedAt: Date;
  /** already resolved to a real path by the reader */
  readonly cwd: string;
  /** a subagent's or a non-interactive exec run's session */
  readonly background: boolean;
}

/**
 * The launched window is the first interactive session in the folder after
 * the launch; later ones are the user's own runs, reading runs or subagents.
 */
export function pickCodexSession(
  headers: Iterable<CodexSessionHeader>,
  workspaceRealPath: string,
  since: Date,
): string | null {
  let best: CodexSessionHeader | null = null;
  for (const header of headers) {
    if (
      header.background || header.cwd !== workspaceRealPath ||
      !isAgentSessionId(header.id) ||
      header.startedAt.getTime() < since.getTime()
    ) {
      continue;
    }
    if (best === null || header.startedAt < best.startedAt) best = header;
  }
  return best?.id ?? null;
}

/** finds the conversation a launch started, for harnesses that pick their own id */
export interface AgentSessionFinder {
  find(
    harness: DetectableAiTool,
    workspacePath: string,
    since: Date,
  ): Promise<string | null>;
}
