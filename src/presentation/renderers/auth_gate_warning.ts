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

/**
 * Report that the auth gate let this run through unverified. Log mode warns
 * through the logger. JSON mode has no console log sink, so it writes one
 * JSON line to stderr instead, leaving stdout to the command's own output.
 */
export function renderAuthGateWarning(
  mode: OutputMode,
  message: string,
  writeStderr: (line: string) => void = (line) => console.error(line),
): void {
  if (mode === "json") {
    writeStderr(JSON.stringify({ warning: message, authMode: "offline" }));
    return;
  }
  getSwampLogger(["swamp", "cli"]).warn`${message}`;
}
