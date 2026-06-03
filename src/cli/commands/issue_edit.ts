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
import {
  consumeStream,
  createLibSwampContext,
  issueEdit,
  type IssueEditDeps,
} from "../../libswamp/mod.ts";
import {
  renderIssueCancelled,
} from "../../presentation/renderers/issue_create.ts";
import { createIssueEditRenderer } from "../../presentation/renderers/issue_edit.ts";
import { EditorService } from "../../infrastructure/editor/editor_service.ts";
import { UserError } from "../../domain/errors.ts";
import { AuthRepository } from "../../infrastructure/persistence/auth_repository.ts";
import { SwampClubClient } from "../../infrastructure/http/swamp_club_client.ts";
import { loadIdentity } from "../load_identity.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

const EDIT_TEMPLATE_HEADER =
  `<!-- Edit the title and body below. Lines starting with '<!--' are stripped. Save and close to submit; leave unchanged to cancel. -->

`;

export function buildEditTemplate(title: string, body: string): string {
  return `${EDIT_TEMPLATE_HEADER}## Title
${title}

## Body
${body}
`;
}

export function parseEditContent(
  content: string,
): { title: string; body: string } | null {
  const cleaned = content
    .split("\n")
    .filter((line) => !line.match(/^\s*<!--.*-->\s*$/))
    .join("\n");

  const titleMatch = cleaned.match(/## Title\s*\n([^\n#][^\n]*)/);
  const title = titleMatch?.[1]?.trim();

  if (!title) {
    return null;
  }

  const bodyIndex = cleaned.indexOf("## Body");
  if (bodyIndex === -1) {
    return { title, body: "" };
  }

  const body = cleaned.substring(bodyIndex + "## Body".length).trim();
  return { title, body };
}

export const issueEditCommand = new Command()
  .name("edit")
  .description("Edit the title or body of an existing swamp-club Lab issue")
  .example("Open the editor to edit an issue", "swamp issue edit 42")
  .example("Update just the title", 'swamp issue edit 42 --title "New title"')
  .example(
    "Update title and body",
    'swamp issue edit 42 --title "New title" --body "New body"',
  )
  .arguments("<number:integer>")
  .option("-t, --title <title:string>", "New title (skips editor for title)")
  .option(
    "-b, --body <body:string>",
    "New body (requires --title, skips editor entirely)",
  )
  .action(async function (options: AnyOptions, issueNumber: number) {
    const ctx = createContext(options as GlobalOptions, ["issue", "edit"]);

    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      throw new UserError("Issue number must be a positive integer.");
    }

    const credentials = await new AuthRepository().load();
    if (!credentials) {
      throw new UserError(
        'Not logged in. Run "swamp auth login" first to edit issues.',
      );
    }

    const identity = await loadIdentity();
    const client = new SwampClubClient(credentials.serverUrl, identity);

    const current = await client.fetchIssue(
      credentials.apiKey,
      issueNumber,
    );

    let title: string;
    let body: string;

    if (options.title && options.body) {
      title = options.title;
      body = options.body;
    } else if (options.body && !options.title) {
      throw new UserError("--body requires --title to be specified.");
    } else if (options.title && !options.body) {
      title = options.title;
      body = current.body;
    } else {
      if (ctx.outputMode === "json") {
        throw new UserError(
          "Interactive mode is not available with --json. Use --title and --body options.",
        );
      }

      const tempFile = await Deno.makeTempFile({
        prefix: "swamp-issue-edit-",
        suffix: ".md",
      });

      try {
        await Deno.writeTextFile(
          tempFile,
          buildEditTemplate(current.title, current.body),
        );
        ctx.logger.debug`Opening editor to edit issue #${issueNumber}`;
        await new EditorService().openFile(tempFile, { wait: true });

        const content = await Deno.readTextFile(tempFile);
        const parsed = parseEditContent(content);
        if (!parsed) {
          renderIssueCancelled(
            { type: "edit", reason: "empty" },
            ctx.outputMode,
          );
          return;
        }

        title = parsed.title;
        body = parsed.body;
      } finally {
        try {
          await Deno.remove(tempFile);
        } catch {
          // Ignore cleanup errors
        }
      }
    }

    const libCtx = createLibSwampContext({ logger: ctx.logger });
    const renderer = createIssueEditRenderer(ctx.outputMode);
    const deps: IssueEditDeps = {
      updateIssue: async (input) => {
        const result = await client.updateIssue(
          credentials.apiKey,
          input.issueNumber,
          input.fields,
        );
        return { ...result, serverUrl: credentials.serverUrl };
      },
    };

    await consumeStream(
      issueEdit(libCtx, deps, {
        issueNumber,
        title,
        body,
        originalTitle: current.title,
        originalBody: current.body,
      }),
      renderer.handlers(),
    );
  });
