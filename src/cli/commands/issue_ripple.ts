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
  issueComment,
  type IssueCommentDeps,
} from "../../libswamp/mod.ts";
import {
  createIssueCommentRenderer,
  renderIssueCancelled,
} from "../../presentation/renderers/issue_create.ts";
import { EditorService } from "../../infrastructure/editor/editor_service.ts";
import { UserError } from "../../domain/errors.ts";
import { AuthRepository } from "../../infrastructure/persistence/auth_repository.ts";
import { SwampClubClient } from "../../infrastructure/http/swamp_club_client.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Editor template for ripples. Comment lines (HTML markers) are stripped
 * by {@link parseRippleContent}, so the hint disappears once the user
 * writes their actual content. Kept on a single line so the per-line
 * filter strips it without needing to handle multi-line comments.
 */
export const RIPPLE_TEMPLATE =
  `<!-- Write your ripple in markdown. Lines starting with '<!--' are stripped. Save and close to post; leave blank to cancel. -->
`;

/**
 * Parse ripple content from the editor. Strips HTML comment lines and
 * trims whitespace. Returns null when the result is empty (treated as a
 * cancellation).
 */
export function parseRippleContent(content: string): string | null {
  const cleaned = content
    .split("\n")
    .filter((line) => !line.match(/^\s*<!--.*-->\s*$/))
    .join("\n")
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

export const issueRippleCommand = new Command()
  .name("ripple")
  .description("Post a ripple (comment) on an existing swamp-club Lab issue")
  .example("Open the editor to write a ripple", "swamp issue ripple 184")
  .example(
    "Post a ripple directly",
    'swamp issue ripple 184 --body "See also #183."',
  )
  .arguments("<number:integer>")
  .option("-b, --body <body:string>", "Ripple body (skips editor)")
  .action(async function (options: AnyOptions, issueNumber: number) {
    const ctx = createContext(options as GlobalOptions, ["issue", "ripple"]);

    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      throw new UserError("Issue number must be a positive integer.");
    }

    const credentials = await new AuthRepository().load();
    if (!credentials) {
      throw new UserError(
        'Not logged in. Run "swamp auth login" first to post ripples.',
      );
    }

    let body: string;

    if (typeof options.body === "string" && options.body.length > 0) {
      body = options.body;
    } else {
      if (ctx.outputMode === "json") {
        throw new UserError(
          "Interactive mode is not available with --json. Use --body to provide the ripple content.",
        );
      }

      const tempFile = await Deno.makeTempFile({
        prefix: "swamp-ripple-",
        suffix: ".md",
      });

      try {
        await Deno.writeTextFile(tempFile, RIPPLE_TEMPLATE);
        ctx.logger.debug`Opening editor for ripple on issue #${issueNumber}`;
        await new EditorService().openFile(tempFile, { wait: true });

        const content = await Deno.readTextFile(tempFile);
        const parsed = parseRippleContent(content);
        if (parsed === null) {
          renderIssueCancelled(
            { type: "ripple", reason: "empty" },
            ctx.outputMode,
          );
          return;
        }
        body = parsed;
      } finally {
        try {
          await Deno.remove(tempFile);
        } catch {
          // Ignore cleanup errors
        }
      }
    }

    const libCtx = createLibSwampContext({ logger: ctx.logger });
    const renderer = createIssueCommentRenderer(ctx.outputMode);
    const client = new SwampClubClient(credentials.serverUrl);
    const deps: IssueCommentDeps = {
      submitToLab: async (input) => {
        const result = await client.submitComment(
          credentials.apiKey,
          input.issueNumber,
          input.body,
        );
        return {
          commentId: result.id,
          serverUrl: credentials.serverUrl,
        };
      },
    };

    await consumeStream(
      issueComment(libCtx, deps, { issueNumber, body }),
      renderer.handlers(),
    );
  });
