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
import type { AuthMode } from "../auth/auth_gate_policy.ts";

/**
 * agentSessionDetected is a soft signal (generic AGENT vars are set by other
 * tooling); configuredAiTools undefined means outside a repo, [] means an
 * explicit tool opt-out
 */
export interface InvocationContext {
  readonly configuredAiTools?: string[];
  readonly detectedAiTool?: DetectableAiTool;
  readonly agentSessionDetected: boolean;
  readonly isInteractive: boolean;
  readonly externalDatastoreConfigured: boolean;
  readonly datastoreType?: string;
  readonly externalVaultConfigured: boolean;
  readonly authMode?: AuthMode;
}

export interface InvocationContextData {
  configuredAiTools?: string[];
  detectedAiTool?: DetectableAiTool;
  agentSessionDetected: boolean;
  isInteractive: boolean;
  externalDatastoreConfigured: boolean;
  datastoreType?: string;
  externalVaultConfigured: boolean;
  authMode?: AuthMode;
}

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
    datastoreType: props.datastoreType,
    externalVaultConfigured: props.externalVaultConfigured,
    authMode: props.authMode,
  };
}

export function invocationContextToData(
  context: InvocationContext,
): InvocationContextData {
  const data: InvocationContextData = {
    agentSessionDetected: context.agentSessionDetected,
    isInteractive: context.isInteractive,
    externalDatastoreConfigured: context.externalDatastoreConfigured,
    externalVaultConfigured: context.externalVaultConfigured,
  };
  if (context.datastoreType !== undefined) {
    data.datastoreType = context.datastoreType;
  }
  if (context.configuredAiTools !== undefined) {
    data.configuredAiTools = [...context.configuredAiTools];
  }
  if (context.detectedAiTool !== undefined) {
    data.detectedAiTool = context.detectedAiTool;
  }
  if (context.authMode !== undefined) {
    data.authMode = context.authMode;
  }
  return data;
}

export function invocationContextFromData(
  data: InvocationContextData,
): InvocationContext {
  return createInvocationContext(data);
}
