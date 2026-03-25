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
  createIssueCreateDeps,
  createLibSwampContext,
  issueCreate,
} from "../../libswamp/mod.ts";
import {
  createIssueCreateRenderer,
  renderIssueCancelled,
} from "../../presentation/renderers/issue_create.ts";
import { EditorService } from "../../infrastructure/editor/editor_service.ts";
import { UserError } from "../../domain/errors.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Template for bug reports.
 */
const BUG_TEMPLATE = `
# Bug Report

## Title
<!-- Enter a brief, descriptive title for the bug on the line below -->


## Description
<!-- Describe the bug in detail. What did you expect to happen? What actually happened? -->


## Steps to Reproduce
<!-- List the steps to reproduce the bug -->
1.
2.
3.

## Environment
<!-- Include relevant environment information -->
- swamp version:
- OS:
- Shell:

## Additional Context
<!-- Add any other context about the problem here -->

`.trimStart();

/**
 * Parses the bug report content from the editor.
 * Returns null if the content is empty or unchanged from the template.
 */
function parseBugContent(
  content: string,
): { title: string; body: string } | null {
  // Check if content is essentially empty or unchanged
  const trimmedContent = content.trim();
  if (!trimmedContent || trimmedContent === BUG_TEMPLATE.trim()) {
    return null;
  }

  // Extract title from the "## Title" section
  // Title must be a single line that doesn't start with # or <!--
  const titleMatch = content.match(
    /## Title\s*\n(?:<!--[^>]*-->\s*\n)?([^\n#<][^\n]*)/,
  );
  const title = titleMatch?.[1]?.trim();

  if (!title) {
    return null;
  }

  // Build body from remaining sections (everything after ## Description)
  const descriptionIndex = content.indexOf("## Description");
  if (descriptionIndex === -1) {
    return { title, body: "" };
  }

  const body = content.substring(descriptionIndex);

  // Clean up the body by removing HTML comment lines
  const cleanedBody = body
    .split("\n")
    .filter((line) => !line.match(/^\s*<!--.*-->\s*$/))
    .join("\n")
    .trim();

  return { title, body: cleanedBody };
}

export const issueBugCommand = new Command()
  .name("bug")
  .description("Submit a bug report")
  .option("-t, --title <title:string>", "Bug title (skips editor for title)")
  .option(
    "-b, --body <body:string>",
    "Bug description (requires --title, skips editor entirely)",
  )
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, ["issue", "bug"]);
    ctx.logger.debug`Submitting bug report`;

    const editorService = new EditorService();

    let title: string;
    let body: string;

    if (options.title && options.body) {
      // Non-interactive mode: both title and body provided
      title = options.title;
      body = options.body;
    } else if (options.body && !options.title) {
      throw new UserError("--body requires --title to be specified");
    } else {
      // Interactive mode: open editor
      if (ctx.outputMode === "json") {
        throw new UserError(
          "Interactive mode is not available with --json. Use --title and --body options.",
        );
      }

      // Create temp file with template
      const tempFile = await Deno.makeTempFile({
        prefix: "swamp-bug-",
        suffix: ".md",
      });

      try {
        // Write template to temp file
        await Deno.writeTextFile(tempFile, BUG_TEMPLATE);

        // Open editor and wait for it to close
        ctx.logger.debug`Opening editor for bug report`;
        await editorService.openFile(tempFile, { wait: true });

        // Read the edited content
        const content = await Deno.readTextFile(tempFile);

        // Parse the content
        const parsed = parseBugContent(content);
        if (!parsed) {
          renderIssueCancelled(
            { type: "bug", reason: "empty" },
            ctx.outputMode,
          );
          return;
        }

        title = parsed.title;
        body = parsed.body;
      } finally {
        // Clean up temp file
        try {
          await Deno.remove(tempFile);
        } catch {
          // Ignore cleanup errors
        }
      }
    }

    ctx.logger.debug`Creating GitHub issue with title: ${title}`;

    const libCtx = createLibSwampContext({ logger: ctx.logger });
    const deps = createIssueCreateDeps();
    const renderer = createIssueCreateRenderer(ctx.outputMode);
    await consumeStream(
      issueCreate(libCtx, deps, {
        title,
        body,
        labels: ["bug", "needs-triage"],
        type: "bug",
      }),
      renderer.handlers(),
    );

    ctx.logger.debug("Bug report submitted successfully");
  });
