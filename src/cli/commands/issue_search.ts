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

import { Command } from "@cliffy/command";
import { createContext, type GlobalOptions } from "../context.ts";
import { consumeStream } from "../../libswamp/stream.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import {
  issueSearch,
  type IssueSearchDeps,
} from "../../libswamp/issues/search.ts";
import { createIssueSearchRenderer } from "../../presentation/renderers/issue_search.ts";
import { AuthRepository } from "../../infrastructure/persistence/auth_repository.ts";
import { SwampClubClient } from "../../infrastructure/http/swamp_club_client.ts";
import { loadIdentity } from "../load_identity.ts";
import { DEFAULT_SWAMP_CLUB_URL } from "../../domain/auth/auth_credentials.ts";
import { UserError } from "../../domain/errors.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

// The filter values swamp-club's Lab accepts for a search. `platform` is a
// valid search filter even though `issue edit --type` cannot set it.
const SEARCH_ISSUE_TYPES = ["bug", "feature", "security", "platform"] as const;
const SEARCH_ISSUE_STATUSES = [
  "open",
  "triaged",
  "in_progress",
  "shipped",
  "closed",
] as const;

/**
 * Throws a UserError for a `--type`, `--status` or `--limit` value the Lab
 * would refuse, so the request is never sent (swamp-club#3577).
 */
export function validateIssueSearchOptions(
  options: { type?: string; status?: string; limit?: number },
): void {
  if (
    options.type !== undefined &&
    !(SEARCH_ISSUE_TYPES as readonly string[]).includes(options.type)
  ) {
    throw new UserError(
      `Invalid issue type "${options.type}". Must be one of: ${
        SEARCH_ISSUE_TYPES.join(", ")
      }`,
    );
  }
  if (
    options.status !== undefined &&
    !(SEARCH_ISSUE_STATUSES as readonly string[]).includes(options.status)
  ) {
    throw new UserError(
      `Invalid issue status "${options.status}". Must be one of: ${
        SEARCH_ISSUE_STATUSES.join(", ")
      }`,
    );
  }
  if (options.limit !== undefined && options.limit < 1) {
    throw new UserError(
      `Invalid limit ${options.limit}. Must be a positive integer.`,
    );
  }
}

export const issueSearchCommand = new Command()
  .name("search")
  .description("Search or list swamp-club Lab issues")
  .example("Search by keyword", "swamp issue search vault")
  .example("List all open bugs", "swamp issue search --type bug --status open")
  .example("List all issues as JSON", "swamp issue search --json")
  .example("Limit results", "swamp issue search --limit 10")
  .arguments("[query:string]")
  .option(
    "--type <type:string>",
    "Filter by issue type (bug, feature, security, platform)",
  )
  .option(
    "--status <status:string>",
    "Filter by status (open, triaged, in_progress, shipped, closed)",
  )
  .option("--source <source:string>", "Filter by source tag")
  .option("--limit <limit:integer>", "Maximum number of results to return")
  .action(async function (options: AnyOptions, query?: string) {
    const ctx = createContext(options as GlobalOptions, ["issue", "search"]);
    validateIssueSearchOptions(options);

    const credentials = await new AuthRepository().load();
    const identity = await loadIdentity();
    const serverUrl = credentials?.serverUrl ??
      Deno.env.get("SWAMP_CLUB_URL") ?? DEFAULT_SWAMP_CLUB_URL;

    const client = new SwampClubClient(serverUrl, identity);
    const deps: IssueSearchDeps = {
      searchIssues: async (input) => {
        const result = await client.searchIssues(credentials?.apiKey, {
          q: input.q,
          type: input.type,
          status: input.status,
          source: input.source,
          limit: input.limit,
        });
        return {
          issues: result.issues.map((issue) => ({
            number: issue.number,
            title: issue.title,
            type: issue.type,
            status: issue.status,
            author: issue.author,
            createdAt: issue.createdAt,
            updatedAt: issue.updatedAt,
            url: `${serverUrl}/lab/${issue.number}`,
          })),
          total: result.total,
        };
      },
    };

    const libCtx = createLibSwampContext({ logger: ctx.logger });
    const renderer = createIssueSearchRenderer(ctx.outputMode);

    await consumeStream(
      issueSearch(libCtx, deps, {
        q: query,
        type: options.type,
        status: options.status,
        source: options.source,
        limit: options.limit,
      }),
      renderer.handlers(),
    );
  });
