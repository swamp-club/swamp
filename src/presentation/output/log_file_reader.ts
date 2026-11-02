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

import type { OutputMode } from "./output.ts";

export interface ReadLogFileOptions {
  tail?: number;
}

export interface LogFileData {
  lines: string[];
  path: string;
}

export async function readLogFile(
  path: string,
  options?: ReadLogFileOptions,
): Promise<LogFileData> {
  let content: string;
  try {
    content = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { lines: [], path };
    }
    throw error;
  }

  let lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines = lines.slice(0, -1);
  }

  if (options?.tail && options.tail > 0) {
    lines = lines.slice(-options.tail);
  }

  return { lines, path };
}

export function renderLogFile(
  data: LogFileData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(
      {
        path: data.path,
        lines: data.lines,
        lineCount: data.lines.length,
      },
      null,
      2,
    ));
  } else {
    for (const line of data.lines) {
      console.log(line);
    }
  }
}
