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

import { bold, cyan, dim, green, yellow } from "@std/fmt/colors";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import type {
  AuthTokenCreateData,
  AuthTokenListData,
  AuthTokenRevokeData,
} from "../../libswamp/mod.ts";
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
    `${bold(cyan("Token:"))} ${bold(data.name)}`,
    `${bold(cyan("Collective:"))} ${data.collective}`,
    `${bold(cyan("Scopes:"))} ${data.scopes.join(", ")}`,
    "",
    `  ${bold(data.key)}`,
    "",
    yellow(
      "This token is shown once and will not be displayed again — store it now.",
    ),
  ];
  writeOutput(lines.join("\n"));
}

export function renderAuthTokenList(
  data: AuthTokenListData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data.tokens, null, 2));
    return;
  }

  if (data.tokens.length === 0) {
    writeOutput(
      [
        `No API tokens found for collective ${bold(data.collective)}.`,
        dim(
          "Create one with: swamp auth token create --collective " +
            data.collective + " --scopes <scopes>",
        ),
      ].join("\n"),
    );
    return;
  }

  const headers = ["NAME", "ID", "PREFIX", "SCOPES", "CREATED", "LAST USED"];
  const rows = data.tokens.map((token) => [
    token.name,
    token.id,
    token.keyPrefix,
    token.scopes.join(", "),
    token.createdAt,
    token.lastUsedAt ?? dim("-"),
  ]);

  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => row[i].length))
  );

  const headerLine = dim(
    headers.map((h, i) => h.padEnd(widths[i])).join("  "),
  );
  const dataLines = rows.map((row) =>
    row
      .map((cell, i) => {
        const padded = cell.padEnd(widths[i]);
        return i === 0 ? bold(padded) : padded;
      })
      .join("  ")
      .trimEnd()
  );

  writeOutput([headerLine, ...dataLines].join("\n"));
}

const checkmark = "✓";

export function renderAuthTokenRevoke(
  data: AuthTokenRevokeData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  writeOutput(
    `${green(checkmark)} Token ${bold(data.name)} revoked from collective ${
      bold(data.collective)
    }.`,
  );
}
