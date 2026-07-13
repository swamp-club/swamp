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

import { bold, cyan, dim } from "@std/fmt/colors";
import {
  AUTH_FIRST_RUN_MESSAGE_LINES,
  AUTH_NUDGE_MESSAGE,
} from "../../domain/auth/auth_nudge.ts";

export function renderAuthNudge(): void {
  console.error("");
  console.error(
    cyan(
      AUTH_NUDGE_MESSAGE.replace(
        "swamp auth login",
        bold("`swamp auth login`"),
      ),
    ),
  );
}

export function renderFirstRunNudge(): void {
  const maxLen = AUTH_FIRST_RUN_MESSAGE_LINES.reduce(
    (max, line) => Math.max(max, line.length),
    0,
  );
  const top = dim(`  ┌${"─".repeat(maxLen + 2)}┐`);
  const bottom = dim(`  └${"─".repeat(maxLen + 2)}┘`);

  console.error("");
  console.error(top);
  for (const line of AUTH_FIRST_RUN_MESSAGE_LINES) {
    const padded = line.padEnd(maxLen);
    const content = line.includes("swamp auth login")
      ? padded.replace("swamp auth login", bold("swamp auth login"))
      : padded;
    console.error(`  ${dim("│")} ${cyan(content)} ${dim("│")}`);
  }
  console.error(bottom);
}
