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

import type {
  ExecutionCallbacks,
  ExecutionDriver,
  ExecutionRequest,
  ExecutionResult,
} from "./execution_driver.ts";

/**
 * Docker execution driver — runs model methods in isolated Docker containers.
 *
 * Not yet implemented. Will serialize ExecutionRequest to JSON, pipe via stdin
 * to `docker run`, stream stderr for real-time logs, and parse ExecutionResult
 * from stdout.
 */
export class DockerExecutionDriver implements ExecutionDriver {
  readonly type = "docker";

  execute(
    _request: ExecutionRequest,
    _callbacks?: ExecutionCallbacks,
  ): Promise<ExecutionResult> {
    throw new Error(
      "Docker execution driver is not yet implemented. " +
        "See Phase 6 of the execution driver plan.",
    );
  }
}
