// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
 * Tools that can be identified at runtime from environment variables. The
 * `none` value of the AiTool union is reserved for the marker file's
 * "explicitly opted out" sentinel — detection never returns it.
 */
export type DetectableAiTool = Exclude<AiTool, "none">;

/**
 * Result of agent-harness detection over an env snapshot.
 *
 * `agentSessionDetected` is a SOFT SIGNAL: it can be flipped on by generic
 * `AGENT` / `AI_AGENT` / `IS_AGENT` env vars that unrelated tooling (CI
 * runners, monitoring agents, build orchestrators) also sets. Dashboards or
 * queries that need precision must cross-reference `detectedAiTool` — when
 * that field is undefined and `agentSessionDetected` is true, we know an
 * agent context is present but cannot identify the harness.
 */
export interface AgentHarnessDetection {
  detectedAiTool?: DetectableAiTool;
  agentSessionDetected: boolean;
}

interface SpecificSignal {
  tool: DetectableAiTool;
  predicate: (env: Record<string, string>) => boolean;
}

/**
 * Tier-1 (high-confidence) and tier-2 (best-effort) signals that map a known
 * env signature to a specific harness. Iteration order is preserved — the
 * first matching entry wins.
 */
const SPECIFIC_HARNESS_SIGNALS: readonly SpecificSignal[] = [
  // Tier-1: well-attested.
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
  // Tier-2: best-effort. Refine these as harness vendors publish stable
  // markers.
  // TODO(swamp-club#292): confirm Kiro's published env signature.
  {
    tool: "kiro",
    predicate: (env) => env.TERM_PROGRAM === "kiro" || env.KIRO_AGENT === "1",
  },
  // TODO(swamp-club#292): confirm OpenCode's published env signature.
  {
    tool: "opencode",
    predicate: (env) =>
      env.OPENCODE_VERSION !== undefined || env.TERM_PROGRAM === "opencode",
  },
  // TODO(swamp-club#292): confirm Codex's published env signature.
  {
    tool: "codex",
    predicate: (env) => env.CODEX_AGENT_HARNESS === "1",
  },
];

const GENERIC_AGENT_SIGNALS = ["AGENT", "AI_AGENT", "IS_AGENT"] as const;

/**
 * The full set of env keys any signal in this module inspects. Application
 * callers project Deno.env down to this whitelist before passing a snapshot
 * to `detectAgentHarness` — keeping the rest of the developer's env
 * (secrets, tokens, unrelated config) out of the telemetry pipeline.
 */
export const RELEVANT_ENV_VARS: readonly string[] = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "TERM_PROGRAM",
  "CURSOR_TRACE_ID",
  "KIRO_AGENT",
  "OPENCODE_VERSION",
  "CODEX_AGENT_HARNESS",
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
 * Detect the AI agent harness wrapping the current process from a whitelist
 * env snapshot. Specific harness signals win over the generic fallback —
 * when both fire (e.g. CLAUDECODE=1 and AGENT=1) the result names the
 * specific tool and still reports `agentSessionDetected: true`.
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
