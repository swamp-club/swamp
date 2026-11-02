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

import type { AiTool } from "../repo/ai_tool.ts";

/**
 * none is reserved for the opted-out marker sentinel; detection never returns
 * it
 */
export type DetectableAiTool = Exclude<AiTool, "none">;

/**
 * agentSessionDetected is a soft signal: generic AGENT vars are also set by CI
 * and other tooling; true with no detectedAiTool means an agent is present but
 * unidentified
 */
export interface AgentHarnessDetection {
  detectedAiTool?: DetectableAiTool;
  agentSessionDetected: boolean;
}

interface SpecificSignal {
  tool: DetectableAiTool;
  predicate: (env: Record<string, string>) => boolean;
}

/** order matters: the first matching entry wins */
const SPECIFIC_HARNESS_SIGNALS: readonly SpecificSignal[] = [
  {
    tool: "claude",
    predicate: (env) =>
      env.CLAUDECODE === "1" || env.CLAUDE_CODE_ENTRYPOINT !== undefined,
  },
  {
    tool: "cursor",
    predicate: (env) =>
      env.TERM_PROGRAM === "cursor" || env.CURSOR_TRACE_ID !== undefined,
  },
  // AGENT_CONTEXT_OUT is a FIFO path Kiro CLI exports only when its agent
  // drives a shell command; the name is generic, so narrow this predicate if
  // another harness collides
  {
    tool: "kiro",
    predicate: (env) =>
      env.TERM_PROGRAM === "kiro" ||
      (env.AGENT_CONTEXT_OUT !== undefined && env.AGENT_CONTEXT_OUT !== ""),
  },
  // opencode sets OPENCODE=1 at startup, inherited by children; it also sets
  // AGENT=1, so the generic fallback would otherwise catch the session
  // anonymously
  {
    tool: "opencode",
    predicate: (env) => env.OPENCODE === "1",
  },
  // Codex clears env before each shell spawn and re-adds only sandbox markers;
  // with the sandbox fully disabled neither is set and codex cannot be detected
  // from a child process
  {
    tool: "codex",
    predicate: (env) =>
      env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ||
      env.CODEX_SANDBOX !== undefined,
  },
  // PI_CODING_AGENT is the vendor-specific signal; AI_AGENT=pi is a fallback,
  // since AI_AGENT is also a generic signal checked only for truthiness
  {
    tool: "pi",
    predicate: (env) => env.PI_CODING_AGENT === "true" || env.AI_AGENT === "pi",
  },
];

const GENERIC_AGENT_SIGNALS = ["AGENT", "AI_AGENT", "IS_AGENT"] as const;

/**
 * callers project the env down to this whitelist before detection, keeping the
 * rest of the environment out of the telemetry pipeline
 */
export const RELEVANT_ENV_VARS: readonly string[] = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "TERM_PROGRAM",
  "CURSOR_TRACE_ID",
  "AGENT_CONTEXT_OUT",
  "OPENCODE",
  "CODEX_SANDBOX_NETWORK_DISABLED",
  "CODEX_SANDBOX",
  "PI_CODING_AGENT",
  ...GENERIC_AGENT_SIGNALS,
];

function genericAgentDetected(env: Record<string, string>): boolean {
  for (const key of GENERIC_AGENT_SIGNALS) {
    const value = env[key];
    if (value && value !== "0" && value.toLowerCase() !== "false") {
      return true;
    }
  }
  return false;
}

/**
 * specific signals win over the generic fallback; when both fire the result
 * names the tool and still reports agentSessionDetected true
 */
export function detectAgentHarness(
  env: Record<string, string>,
): AgentHarnessDetection {
  for (const signal of SPECIFIC_HARNESS_SIGNALS) {
    if (signal.predicate(env)) {
      return { detectedAiTool: signal.tool, agentSessionDetected: true };
    }
  }
  return { agentSessionDetected: genericAgentDetected(env) };
}
