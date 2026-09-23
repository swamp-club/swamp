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

import { bold, cyan, dim, green, red } from "@std/fmt/colors";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import type { AccessListCheckEntry } from "../../serve/oauth_access_list_resolution.ts";
import type { OutputMode } from "./output.ts";

export interface ServeCheckConfigData {
  /** True when every name resolved and serve would start. */
  readonly passed: boolean;
  readonly authMode: "none" | "token" | "oauth";
  /** Set in oauth mode. */
  readonly oauthProvider?: string;
  readonly entries: readonly AccessListCheckEntry[];
  readonly allowedCollectives: readonly string[];
  readonly wouldStart: boolean;
  /** Why serve would refuse to start; set when `wouldStart` is false. */
  readonly refusal?: string;
}

const CHECKMARK = "✓";
const CROSS = "✗";
const ARROW = "→";

function entryLines(
  entries: readonly AccessListCheckEntry[],
  provider: string,
): string[] {
  return entries.map((e) =>
    e.status === "resolved"
      ? `  ${green(CHECKMARK)} ${e.entry} ${dim(`${ARROW} ${e.sub}`)}`
      : `  ${red(CROSS)} ${e.entry} ${red(`${ARROW} not found on ${provider}`)}`
  );
}

export function renderServeCheckConfig(
  data: ServeCheckConfigData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    // deno-lint-ignore no-console
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const lines: string[] = [];
  lines.push(`${bold(cyan("Auth mode:"))} ${bold(data.authMode)}`);

  if (data.authMode !== "oauth" || data.oauthProvider === undefined) {
    lines.push(dim("  No usernames to resolve in this mode."));
  } else {
    const provider = data.oauthProvider;
    lines.push(`${bold(cyan("OAuth provider:"))} ${provider}`);

    const admins = data.entries.filter((e) => e.kind === "admin");
    const allowedUsers = data.entries.filter((e) => e.kind === "allowed-user");

    lines.push("");
    lines.push(cyan("Admins:"));
    lines.push(...entryLines(admins, provider));

    if (allowedUsers.length > 0) {
      lines.push("");
      lines.push(cyan("Allowed users:"));
      lines.push(...entryLines(allowedUsers, provider));
    }

    if (data.allowedCollectives.length > 0) {
      lines.push("");
      lines.push(
        `${cyan("Allowed collectives:")} ${data.allowedCollectives.join(", ")}`,
      );
    }

    if (data.refusal !== undefined) {
      lines.push("");
      lines.push(`${red(CROSS)} ${red("swamp serve would refuse to start:")}`);
      lines.push(`  ${data.refusal}`);
    }
  }

  const notFound = data.entries.filter((e) => e.status === "not-found").length;
  let result = green("PASSED");
  if (!data.passed) {
    const why = data.refusal !== undefined
      ? "swamp serve would refuse to start"
      : `${notFound} unknown name(s); swamp serve would start without them`;
    result = `${red("FAILED")} ${dim(`(${why})`)}`;
  }
  lines.push("");
  lines.push(`${bold(cyan("Result:"))} ${result}`);
  writeOutput(lines.join("\n"));
}
