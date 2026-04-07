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
  renderIssueCancelled,
} from "../../presentation/renderers/issue_create.ts";
import { EditorService } from "../../infrastructure/editor/editor_service.ts";
import { UserError } from "../../domain/errors.ts";
import { resolveDestination, submitIssue } from "./issue_submit.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Template for feature requests.
 */
const FEATURE_TEMPLATE = `
# Feature Request

## Title
<!-- Enter a brief, descriptive title for the feature on the line below -->


## Problem Statement
<!-- What problem does this feature solve? What pain point are you experiencing? -->


## Proposed Solution
<!-- Describe the solution you'd like to see -->


## Alternatives Considered
<!-- Have you considered any alternative solutions or workarounds? -->


## Additional Context
<!-- Add any other context, mockups, or examples about the feature request here -->

`.trimStart();

/**
 * Parses the feature request content from the editor.
 * Returns null if the content is empty or unchanged from the template.
 */
function parseFeatureContent(
  content: string,
): { title: string; body: string } | null {
  // Check if content is essentially empty or unchanged
  const trimmedContent = content.trim();
  if (!trimmedContent || trimmedContent === FEATURE_TEMPLATE.trim()) {
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

  // Build body from remaining sections (everything after ## Problem Statement)
  const problemIndex = content.indexOf("## Problem Statement");
  if (problemIndex === -1) {
    return { title, body: "" };
  }

  const body = content.substring(problemIndex);

  // Clean up the body by removing HTML comment lines
  const cleanedBody = body
    .split("\n")
    .filter((line) => !line.match(/^\s*<!--.*-->\s*$/))
    .join("\n")
    .trim();

  return { title, body: cleanedBody };
}

export const issueFeatureCommand = new Command()
  .name("feature")
  .description("Submit a feature request")
  .example("Submit a feature request", "swamp issue feature")
  .option(
    "-t, --title <title:string>",
    "Feature title (skips editor for title)",
  )
  .option(
    "-b, --body <body:string>",
    "Feature description (requires --title, skips editor entirely)",
  )
  .option("-e, --email", "Open email client with pre-filled feature request")
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, ["issue", "feature"]);
    ctx.logger.debug`Submitting feature request`;

    // Resolve destination BEFORE collecting content so we don't waste the user's time
    const destination = await resolveDestination(ctx, options.email);
    if (destination.method === "abort") {
      await submitIssue(ctx, destination, {
        type: "feature",
        title: "",
        body: "",
      });
      return;
    }

    const editorService = new EditorService();

    let title: string;
    let body: string;

    if (options.title && options.body) {
      title = options.title;
      body = options.body;
    } else if (options.body && !options.title) {
      throw new UserError("--body requires --title to be specified");
    } else {
      if (ctx.outputMode === "json") {
        throw new UserError(
          "Interactive mode is not available with --json. Use --title and --body options.",
        );
      }

      const tempFile = await Deno.makeTempFile({
        prefix: "swamp-feature-",
        suffix: ".md",
      });

      try {
        await Deno.writeTextFile(tempFile, FEATURE_TEMPLATE);
        ctx.logger.debug`Opening editor for feature request`;
        await editorService.openFile(tempFile, { wait: true });

        const content = await Deno.readTextFile(tempFile);
        const parsed = parseFeatureContent(content);
        if (!parsed) {
          renderIssueCancelled(
            { type: "feature", reason: "empty" },
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

    ctx.logger.debug`Submitting feature request with title: ${title}`;

    await submitIssue(ctx, destination, {
      type: "feature",
      title,
      body,
    });

    ctx.logger.debug("Feature request submitted successfully");
  });
