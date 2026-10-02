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

/** The offline warning as fields on a JSON-mode document. */
export interface AuthGateWarningFields {
  warning: string;
  authMode: "offline";
}

// The JSON-mode warning held until the run ends (swamp-club#2938).
let pendingWarning: string | undefined;

/**
 * Report that the auth gate let this run through unverified. Log mode warns
 * through the logger. JSON mode has no console log sink, and stderr must stay
 * one JSON document when the command fails, so the warning is held: a fatal
 * error takes it as fields on its own document (`takeAuthGateWarning`), and
 * any other run writes it as one JSON line to stderr when the process exits.
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

/**
 * Take the held JSON-mode warning for a fatal error document, so the exit
 * hook writes nothing. Returns `undefined` when no warning is held.
 */
export function takeAuthGateWarning(): AuthGateWarningFields | undefined {
  const message = pendingWarning;
  pendingWarning = undefined;
  return message === undefined
    ? undefined
    : { warning: message, authMode: "offline" };
}

/** Write the held JSON-mode warning as one JSON line, if one is held. */
export function flushAuthGateWarning(
  writeStderr: (line: string) => void = (line) => console.error(line),
): void {
  const fields = takeAuthGateWarning();
  if (fields) writeStderr(JSON.stringify(fields));
}
