// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { Command } from "@cliffy/command";
import { createContext, type GlobalOptions } from "../context.ts";
import { HttpAuthClient } from "../../infrastructure/auth/http_auth_client.ts";
import { CredentialRepository } from "../../infrastructure/auth/credential_repository.ts";
import { renderAuthWhoami } from "../../presentation/output/auth_output.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const authWhoamiCommand = new Command()
  .name("whoami")
  .description("Show current authenticated user")
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, ["auth", "whoami"]);
    const client = new HttpAuthClient();
    const store = new CredentialRepository();

    const credentials = await store.load();
    if (!credentials) {
      renderAuthWhoami({ loggedIn: false }, ctx.outputMode);
      return;
    }

    // Validate session with server
    const session = await client.getSession(credentials.sessionToken);
    if (!session) {
      // Session expired, clean up stale credentials
      await store.remove();
      renderAuthWhoami({ loggedIn: false }, ctx.outputMode);
      return;
    }

    renderAuthWhoami(
      {
        loggedIn: true,
        email: session.user.email,
        name: session.user.name,
        userId: session.user.id,
      },
      ctx.outputMode,
    );
  });
