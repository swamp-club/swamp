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

import type { OutputMode } from "../output/output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";

export interface AuthGateWarningFields {
  warning: string;
  authMode: "offline";
}

let pendingWarning: string | undefined;

/**
 * JSON mode holds the warning so stderr stays one JSON document: a fatal error
 * takes it as fields on its own document, any other run writes one JSON line at
 * exit.
 */
export function renderAuthGateWarning(
  mode: OutputMode,
  message: string,
  registerExitHook: (hook: () => void) => void = (hook) =>
    globalThis.addEventListener("unload", hook),
): void {
  if (mode === "json") {
    pendingWarning = message;
    // Deno fires unload on Deno.exit too, so commands that exit early still
    // write the warning. The flush takes the warning, so a second hook
    // writes nothing.
    registerExitHook(() => flushAuthGateWarning());
    return;
  }
  getSwampLogger(["swamp", "cli"]).warn`${message}`;
}

export function takeAuthGateWarning(): AuthGateWarningFields | undefined {
  const message = pendingWarning;
  pendingWarning = undefined;
  return message === undefined
    ? undefined
    : { warning: message, authMode: "offline" };
}

export function flushAuthGateWarning(
  writeStderr: (line: string) => void = (line) => console.error(line),
): void {
  const fields = takeAuthGateWarning();
  if (fields) writeStderr(JSON.stringify(fields));
}
