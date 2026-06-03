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

import { bold, yellow } from "@std/fmt/colors";
import type { UpdateNotification } from "../../domain/update/update_notification_service.ts";

/**
 * Renders a one-line update notification banner to stderr.
 * Uses stderr so it never corrupts piped stdout.
 */
export function renderUpdateNotification(
  notification: UpdateNotification,
): void {
  let message: string;

  switch (notification.type) {
    case "update_available":
      message = yellow(
        `A new version of swamp is available. Run ${
          bold("`swamp update`")
        } to upgrade.`,
      );
      break;
    case "version_stale":
      message = yellow(
        `Your swamp version is ${notification.versionAgeDays} days old. Run ${
          bold("`swamp update`")
        } to upgrade.`,
      );
      break;
  }

  console.error("");
  console.error(message);
}
