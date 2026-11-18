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

import { unguardedConsole } from "../../domain/models/console_guard.ts";
import { runFileSink } from "../../infrastructure/logging/run_file_sink.ts";

/**
 * a method running in process swaps the global console, which would send this
 * line to stderr and into that method's logs, so it goes to stdout unguarded
 */
export function writeServeJsonLine(line: string): void {
  unguardedConsole.log(runFileSink.redactActive(line));
}
