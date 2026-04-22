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
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import {
  renderIssueCancelled,
} from "../../presentation/renderers/issue_create.ts";
import { EditorService } from "../../infrastructure/editor/editor_service.ts";
import { UserError } from "../../domain/errors.ts";
import {
  dispatchExtensionRepositoryReport,
  resolveDestination,
  resolveExtensionOrRefuse,
  submitIssue,
  type UsableExtensionTarget,
} from "./issue_submit.ts";

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
  .example("Submit a bug report", "swamp issue bug")
  .example(
    "Report a bug against a specific extension",
    "swamp issue bug --extension @adam/cfgmgmt",
  )
  .option("-t, --title <title:string>", "Bug title (skips editor for title)")
  .option(
    "-b, --body <body:string>",
    "Bug description (requires --title, skips editor entirely)",
  )
  .option("-e, --email", "Open email client with pre-filled bug report")
  .option(
    "-x, --extension <name:string>",
    "Route the bug against a specific extension (e.g. @adam/cfgmgmt)",
  )
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR) — only used with --extension",
  )
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, ["issue", "bug"]);
    ctx.logger.debug`Submitting bug report`;

    if (options.email && options.extension) {
      throw new UserError("--email and --extension cannot be used together.");
    }

    // Extension-aware pre-flight: resolve the target BEFORE auth so refusals
    // and third-party repository handoffs don't spuriously fail on Lab auth
    // (they never touch swamp-club).
    let extensionTarget: UsableExtensionTarget | undefined;
    if (options.extension) {
      const resolved = await resolveExtensionOrRefuse(
        ctx,
        options.extension,
        resolveRepoDir(options.repoDir),
      );
      if (resolved === null) return; // refusal rendered
      extensionTarget = resolved;
    }

    // Lab auth is only needed for the plain path and the `@swamp/*` path.
    // Third-party repository handoffs skip this step entirely.
    const destination = !extensionTarget || extensionTarget.kind === "swamp-lab"
      ? await resolveDestination(ctx, options.email)
      : undefined;
    if (destination?.method === "abort") {
      await submitIssue(ctx, destination, {
        type: "bug",
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
        prefix: "swamp-bug-",
        suffix: ".md",
      });

      try {
        await Deno.writeTextFile(tempFile, BUG_TEMPLATE);
        ctx.logger.debug`Opening editor for bug report`;
        await editorService.openFile(tempFile, { wait: true });

        const content = await Deno.readTextFile(tempFile);
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
        try {
          await Deno.remove(tempFile);
        } catch {
          // Ignore cleanup errors
        }
      }
    }

    ctx.logger.debug`Submitting bug report with title: ${title}`;

    if (extensionTarget?.kind === "repository") {
      await dispatchExtensionRepositoryReport(ctx, extensionTarget, {
        type: "bug",
        title,
        body,
      });
      return;
    }

    await submitIssue(ctx, destination!, {
      type: "bug",
      title,
      body,
      swampLabTarget: extensionTarget?.kind === "swamp-lab"
        ? extensionTarget
        : undefined,
    });

    ctx.logger.debug("Bug report submitted successfully");
  });
