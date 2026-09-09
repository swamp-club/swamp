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
import { writeOutput } from "../../infrastructure/logging/logger.ts";

export interface AuditExportOutputData {
  readonly format: string;
  readonly count: number;
  readonly truncated?: boolean;
  readonly data: string;
  readonly outputPath?: string;
}

export function createAuditExportRenderer(outputMode: OutputMode) {
  return {
    handlers() {
      return {
        completed(event: { kind: "completed"; data: AuditExportOutputData }) {
          const { data } = event;

          if (outputMode === "json") {
            writeOutput(
              JSON.stringify({
                format: data.format,
                count: data.count,
                truncated: data.truncated ?? false,
                outputPath: data.outputPath,
              }),
            );
            return;
          }

          if (data.outputPath) {
            writeOutput(
              `Exported ${data.count} event(s) in ${data.format} format to ${data.outputPath}`,
            );
          } else {
            writeOutput(data.data);
          }

          if (data.truncated) {
            writeOutput(
              "\nWarning: Results truncated. Narrow the date range for complete data.",
            );
          }
        },
      };
    },
  };
}
