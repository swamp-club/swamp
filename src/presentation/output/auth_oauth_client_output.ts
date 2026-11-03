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

import { bold, cyan, yellow } from "@std/fmt/colors";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import type { AuthOAuthClientRegisterData } from "../../libswamp/auth/oauth_client_register.ts";
import type { OutputMode } from "./output.ts";

export function renderAuthOAuthClientRegister(
  data: AuthOAuthClientRegisterData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  writeOutput([
    `${bold(cyan("OAuth client:"))} ${bold(data.clientName)}`,
    `${bold(cyan("Provider:"))} ${data.provider}`,
    `${bold(cyan("Client id:"))} ${data.clientId}`,
    `${bold(cyan("Client secret:"))}`,
    "",
    `  ${bold(data.clientSecret)}`,
    "",
    "Start swamp serve with --oauth-client-id (or SWAMP_OAUTH_CLIENT_ID) and the secret in",
    "--oauth-client-secret-file, SWAMP_OAUTH_CLIENT_SECRET_FILE or SWAMP_OAUTH_CLIENT_SECRET.",
    yellow(
      "The secret is shown once and will not be displayed again — store it now.",
    ),
  ].join("\n"));
}
