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

import {
  type Principal,
  principalToString,
} from "../domain/access/principal.ts";
import {
  accessCallerOf,
  callerResourceDecider,
  type ConnectionContext,
} from "./handlers/shared.ts";
import {
  captureRunPrincipal,
  type RunPrincipalInputs,
} from "./run_vault_access_policy.ts";

export interface ResumeCaller {
  readonly principal: Principal | null;
  readonly accessAdmin: boolean;
  /** null with authorization off: there is no one to hold the resume to */
  readonly vaultScope: RunPrincipalInputs | null;
}

export function captureResumeCaller(
  ctx: ConnectionContext,
  socket: WebSocket,
  principal: Principal | null,
): ResumeCaller {
  if (ctx.authConfig.mode === "none" || !principal) {
    return { principal, accessAdmin: false, vaultScope: null };
  }
  const accessAdmin = callerResourceDecider(
    accessCallerOf(socket, principal),
    "admin",
    ctx,
  )({ kind: "access", name: "*", fields: {} });
  return {
    principal,
    accessAdmin,
    vaultScope: captureRunPrincipal(socket, principal),
  };
}

export const RESUME_INPUTS_REFUSED = "inputs_refused" as const;

export const RESUME_INPUTS_REFUSED_MESSAGE =
  "Only the person who started this run, or an admin, can add inputs when resuming it. Resume it without inputs, or ask them to resume it.";

/**
 * inputs are write-once and every later continuation acts on them with the
 * starter's access, so only the starter or an admin may add them
 */
export function resumeInputsRefusal(
  run: { readonly initiatedBy?: string },
  caller: ResumeCaller,
  inputs: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  if (!inputs || Object.keys(inputs).length === 0) return undefined;
  if (caller.vaultScope === null || caller.principal === null) return undefined;
  if (caller.accessAdmin) return undefined;
  if (
    run.initiatedBy !== undefined &&
    run.initiatedBy === principalToString(caller.principal)
  ) return undefined;
  return RESUME_INPUTS_REFUSED_MESSAGE;
}
