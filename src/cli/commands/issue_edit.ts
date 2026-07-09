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
import {
  formatRedactionSummary,
  redactIssueTitleAndBody,
} from "../../domain/issues/content_redactor.ts";
import { AuthRepository } from "../../infrastructure/persistence/auth_repository.ts";
import { SwampClubClient } from "../../infrastructure/http/swamp_club_client.ts";
import { loadIdentity } from "../load_identity.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

const EDIT_TEMPLATE_HEADER =
  `<!-- Edit the title, type, and body below. Lines starting with '<!--' are stripped. Save and close to submit; leave unchanged to cancel. -->

`;

const VALID_ISSUE_TYPES = ["bug", "feature", "security"] as const;

export function buildEditTemplate(
  title: string,
  body: string,
  type?: string,
): string {
  if (type) {
    return `${EDIT_TEMPLATE_HEADER}## Title
${title}

## Type (bug, feature, or security)
${type}

## Body
${body}
`;
  }
  return `${EDIT_TEMPLATE_HEADER}## Title
${title}

## Body
${body}
`;
}

export function parseEditContent(
  content: string,
): { title: string; body: string; type?: string } | null {
  const cleaned = content
    .split("\n")
    .filter((line) => !line.match(/^\s*<!--.*-->\s*$/))
    .join("\n");

  const titleMatch = cleaned.match(/## Title\s*\n([^\n#][^\n]*)/);
  const title = titleMatch?.[1]?.trim();

  if (!title) {
    return null;
  }

  const typeMatch = cleaned.match(
    /## Type[^\n]*\n([^\n#][^\n]*)/,
  );
  const type = typeMatch?.[1]?.trim();

  const bodyIndex = cleaned.indexOf("## Body");
  if (bodyIndex === -1) {
    return { title, body: "", ...(type ? { type } : {}) };
  }

  const body = cleaned.substring(bodyIndex + "## Body".length).trim();
  return { title, body, ...(type ? { type } : {}) };
}

export const issueEditCommand = new Command()
  .name("edit")
  .description(
    "Edit the title, body, or type of an existing swamp-club Lab issue",
  )
  .example("Open the editor to edit an issue", "swamp issue edit 42")
  .example("Update just the title", 'swamp issue edit 42 --title "New title"')
  .example(
    "Update title and body",
    'swamp issue edit 42 --title "New title" --body "New body"',
  )
  .example(
    "Change the issue type to security",
    "swamp issue edit 42 --type security",
  )
  .arguments("<number:integer>")
  .option("-t, --title <title:string>", "New title (skips editor for title)")
  .option(
    "-b, --body <body:string>",
    "New body (requires --title, skips editor entirely)",
  )
  .option(
    "--type <type:string>",
    "Change issue type (bug, feature, or security); escalating to security restricts visibility and cannot be reversed by non-admins",
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
    let type: string | undefined;

    if (
      options.type &&
      !VALID_ISSUE_TYPES.includes(options.type)
    ) {
      throw new UserError(
        `Invalid issue type "${options.type}". Must be one of: ${
          VALID_ISSUE_TYPES.join(", ")
        }`,
      );
    }

    if (options.title && options.body) {
      title = options.title;
      body = options.body;
      type = options.type;
    } else if (options.body && !options.title) {
      throw new UserError("--body requires --title to be specified.");
    } else if (options.title && !options.body) {
      title = options.title;
      body = current.body;
      type = options.type;
    } else if (options.type && !options.title) {
      title = current.title;
      body = current.body;
      type = options.type;
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
          buildEditTemplate(current.title, current.body, current.type),
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
        if (parsed.type) {
          if (
            !VALID_ISSUE_TYPES.includes(
              parsed.type as typeof VALID_ISSUE_TYPES[number],
            )
          ) {
            throw new UserError(
              `Invalid issue type "${parsed.type}". Must be one of: ${
                VALID_ISSUE_TYPES.join(", ")
              }`,
            );
          }
          type = parsed.type;
        }
      } finally {
        try {
          await Deno.remove(tempFile);
        } catch {
          // Ignore cleanup errors
        }
      }
    }

    // Redact sensitive content before submission.
    const redacted = redactIssueTitleAndBody(title, body);
    if (redacted.summary.totalRedactions > 0) {
      const msg = formatRedactionSummary(redacted.summary);
      ctx.logger.info`${msg}`;
      if (ctx.outputMode === "json") {
        console.error(msg);
      }
    }
    title = redacted.title.text;
    body = redacted.body.text;

    const libCtx = createLibSwampContext({ logger: ctx.logger });
    const renderer = createIssueEditRenderer(ctx.outputMode);
    const deps: IssueEditDeps = {
      updateIssue: async (input) => {
        const result = await client.updateIssue(
          credentials.apiKey,
          input.issueNumber,
          input.fields,
        );
        return {
          ...result,
          url: `${credentials.serverUrl}/lab/${input.issueNumber}`,
        };
      },
    };

    await consumeStream(
      issueEdit(libCtx, deps, {
        issueNumber,
        title,
        body,
        type,
        originalTitle: current.title,
        originalBody: current.body,
        originalType: current.type,
      }),
      renderer.handlers(),
    );
  });
