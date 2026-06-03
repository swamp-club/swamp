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

import type { DetectableAiTool } from "./agent_harness_detection.ts";

/**
 * Captures the runtime conditions of a single CLI invocation: which AI
 * tools the repo is configured for, which agent harness (if any) wraps the
 * process, and whether stdin is attached to a terminal.
 *
 * `agentSessionDetected` is a SOFT SIGNAL — it can flip true on generic
 * AGENT/AI_AGENT/IS_AGENT env vars that unrelated tooling also sets.
 * Consumers needing precision (dashboards, leaderboards, billing-relevant
 * counts) MUST cross-reference `detectedAiTool`. When detectedAiTool is
 * undefined and agentSessionDetected is true, an agent context is present
 * but the harness could not be identified.
 *
 * `configuredAiTools` distinguishes two states with different downstream
 * meanings:
 *  - `undefined` — the entry was recorded outside a swamp repo (forward-
 *    compat reserve; today initTelemetryService bails before recording in
 *    this case).
 *  - `[]` — the repo exists with `tools: []` (legacy `tool: none`
 *    normalised), an explicit opt-out of tool integration.
 */
export interface InvocationContext {
  readonly configuredAiTools?: string[];
  readonly detectedAiTool?: DetectableAiTool;
  readonly agentSessionDetected: boolean;
  readonly isInteractive: boolean;
  readonly externalDatastoreConfigured: boolean;
}

/**
 * Data transfer object for InvocationContext.
 */
export interface InvocationContextData {
  configuredAiTools?: string[];
  detectedAiTool?: DetectableAiTool;
  agentSessionDetected: boolean;
  isInteractive: boolean;
  externalDatastoreConfigured: boolean;
}

/**
 * Creates an InvocationContext value object.
 */
export function createInvocationContext(
  props: InvocationContextData,
): InvocationContext {
  return {
    configuredAiTools: props.configuredAiTools
      ? [...props.configuredAiTools]
      : undefined,
    detectedAiTool: props.detectedAiTool,
    agentSessionDetected: props.agentSessionDetected,
    isInteractive: props.isInteractive,
    externalDatastoreConfigured: props.externalDatastoreConfigured,
  };
}

/**
 * Converts an InvocationContext to its data representation.
 */
export function invocationContextToData(
  context: InvocationContext,
): InvocationContextData {
  const data: InvocationContextData = {
    agentSessionDetected: context.agentSessionDetected,
    isInteractive: context.isInteractive,
    externalDatastoreConfigured: context.externalDatastoreConfigured,
  };
  if (context.configuredAiTools !== undefined) {
    data.configuredAiTools = [...context.configuredAiTools];
  }
  if (context.detectedAiTool !== undefined) {
    data.detectedAiTool = context.detectedAiTool;
  }
  return data;
}

/**
 * Reconstructs an InvocationContext from data.
 */
export function invocationContextFromData(
  data: InvocationContextData,
): InvocationContext {
  return createInvocationContext(data);
}
