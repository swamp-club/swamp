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

import { runCli } from "./src/cli/mod.ts";
import { initializeLogging } from "./src/infrastructure/logging/logger.ts";
import { renderError } from "./src/presentation/output/error_output.ts";

if (import.meta.main) {
  try {
    await runCli(Deno.args);
  } catch (error) {
    await initializeLogging({
      jsonMode: Deno.args.includes("--json"),
    });
    renderError(error);
    Deno.exit(1);
  }
}
