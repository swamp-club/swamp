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

import { bold, dim, green, red } from "@std/fmt/colors";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import type { AuditVerifyResponse } from "../../serve/protocol.ts";
import type { OutputMode } from "./output.ts";

export function renderAuditVerify(
  data: AuditVerifyResponse,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (data.valid) {
    writeOutput(
      `${green("✓")} ${
        bold("Chain integrity verified")
      }: ${data.eventsChecked} events checked`,
    );
    if (data.message) writeOutput(dim(data.message));
  } else {
    writeOutput(
      `${red("✗")} ${bold("Chain integrity broken")} at sequence ${
        data.brokenAt ?? "unknown"
      }: ${data.eventsChecked} events checked`,
    );
    if (data.message) writeOutput(dim(data.message));
  }

  if (data.hmacChecked !== undefined) {
    if (data.hmacValid) {
      writeOutput(
        `${green("✓")} ${
          bold("HMAC integrity verified")
        }: ${data.hmacChecked} events checked`,
      );
    } else {
      writeOutput(
        `${red("✗")} ${bold("HMAC integrity failed")}: ${
          data.hmacFailed ?? 0
        } of ${data.hmacChecked} events failed verification`,
      );
    }
  }
}
