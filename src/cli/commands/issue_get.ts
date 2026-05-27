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
import {
  consumeStream,
  createLibSwampContext,
  issueGet,
  type IssueGetDeps,
} from "../../libswamp/mod.ts";
import { createIssueGetRenderer } from "../../presentation/renderers/issue_get.ts";
import { AuthRepository } from "../../infrastructure/persistence/auth_repository.ts";
import { SwampClubClient } from "../../infrastructure/http/swamp_club_client.ts";
import { loadIdentity } from "../load_identity.ts";
import { UserError } from "../../domain/errors.ts";
import { DEFAULT_SWAMP_CLUB_URL } from "../../domain/auth/auth_credentials.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const issueGetCommand = new Command()
  .name("get")
  .description("Fetch and display details of a swamp-club Lab issue")
  .example("View issue details", "swamp issue get 42")
  .example("Get issue as JSON", "swamp issue get 42 --json")
  .arguments("<number:integer>")
  .action(async function (options: AnyOptions, issueNumber: number) {
    const ctx = createContext(options as GlobalOptions, ["issue", "get"]);

    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      throw new UserError("Issue number must be a positive integer.");
    }

    const credentials = await new AuthRepository().load();
    const identity = await loadIdentity();
    const serverUrl = credentials?.serverUrl ??
      Deno.env.get("SWAMP_CLUB_URL") ?? DEFAULT_SWAMP_CLUB_URL;

    const client = new SwampClubClient(serverUrl, identity);
    const deps: IssueGetDeps = {
      fetchIssue: async (num) => {
        const issue = await client.fetchIssue(credentials?.apiKey, num);
        return { ...issue, serverUrl };
      },
    };

    const libCtx = createLibSwampContext({ logger: ctx.logger });
    const renderer = createIssueGetRenderer(ctx.outputMode);

    await consumeStream(
      issueGet(libCtx, deps, { issueNumber }),
      renderer.handlers(),
    );
  });
