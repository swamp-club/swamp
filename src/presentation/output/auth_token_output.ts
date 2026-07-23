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

import { bold, cyan, yellow } from "@std/fmt/colors";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import type { AuthTokenCreateData } from "../../libswamp/mod.ts";
import type { OutputMode } from "./output.ts";

export function renderAuthTokenCreate(
  data: AuthTokenCreateData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const lines = [
    `Token created for collective "${data.collective}"`,
    `${bold(cyan("Scopes:"))} ${data.scopes.join(", ")}`,
    "",
    `  ${bold(data.key)}`,
    "",
    yellow(
      "This token is shown once and will not be displayed again — save it now.",
    ),
  ];
  writeOutput(lines.join("\n"));
}
