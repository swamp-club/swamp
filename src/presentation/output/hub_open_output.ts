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

import { bold, cyan, dim, green } from "@std/fmt/colors";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import type { OutputMode } from "./output.ts";

export interface HubOpenedData {
  readonly url: string;
  readonly port: number;
  readonly pid: number;
}

export function renderHubOpened(
  mode: OutputMode,
  data: HubOpenedData,
  opened: boolean,
): void {
  if (mode === "json") {
    // deno-lint-ignore no-console
    console.log(JSON.stringify({ ...data, opened }, null, 2));
    return;
  }
  writeOutput(
    [
      opened
        ? `${green("✓")} Opened your ${bold("swamp hub")} overview:`
        : "Open your swamp hub overview in your browser:",
      `  ${cyan(data.url)}`,
      dim(
        `  Hub pid ${data.pid} on port ${data.port}. The page keeps its access while it is open.`,
      ),
    ].join("\n"),
  );
}
