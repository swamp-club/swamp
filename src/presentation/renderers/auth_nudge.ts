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

import { bold, dim, yellow } from "@std/fmt/colors";
import {
  AUTH_WARNING_FIRST_RUN_LINES,
  AUTH_WARNING_MESSAGE,
} from "../../domain/auth/auth_nudge.ts";

export function renderAuthWarning(): void {
  console.error("");
  console.error(
    yellow(
      `⚠ ${
        AUTH_WARNING_MESSAGE.replace(
          "`swamp auth login`",
          bold("`swamp auth login`"),
        )
      }`,
    ),
  );
}

export function renderFirstRunWarning(): void {
  const headerPrefix = "⚠ ";
  const maxLen = AUTH_WARNING_FIRST_RUN_LINES.reduce(
    (max, line) => {
      const visual = line.startsWith("Authentication required")
        ? headerPrefix.length + line.length
        : line.length;
      return Math.max(max, visual);
    },
    0,
  );
  const top = dim(`  ┌${"─".repeat(maxLen + 2)}┐`);
  const bottom = dim(`  └${"─".repeat(maxLen + 2)}┘`);

  console.error("");
  console.error(top);
  for (const line of AUTH_WARNING_FIRST_RUN_LINES) {
    const isHeader = line.startsWith("Authentication required");
    const raw = isHeader ? `${headerPrefix}${line}` : line;
    const padded = raw.padEnd(maxLen);
    const content = padded.includes("swamp auth login")
      ? padded.replace("swamp auth login", bold("swamp auth login"))
      : padded;
    console.error(
      `  ${dim("│")} ${yellow(content)} ${dim("│")}`,
    );
  }
  console.error(bottom);
}
