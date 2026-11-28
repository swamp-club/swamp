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

import { bold, dim } from "@std/fmt/colors";
import {
  escapeControlCharacters,
  escapeControlCharactersInText,
} from "../../domain/control_characters.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import type { AuditReportResponse } from "../../serve/protocol.ts";
import type { OutputMode } from "./output.ts";

export function renderAuditReport(
  data: AuditReportResponse,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const esc = escapeControlCharacters;
  writeOutput(bold(`${esc(data.name)}: ${esc(data.description)}`));
  writeOutput(dim(`Period: ${esc(data.from)} to ${esc(data.to)}`));
  writeOutput(dim(`Generated: ${esc(data.generatedAt)}`));
  writeOutput("");
  writeOutput(escapeControlCharactersInText(data.markdown));
}
