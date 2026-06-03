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
 * Template for security reports.
 */
const SECURITY_TEMPLATE = `
# Security Report

## Title
<!-- Enter a brief, descriptive title for the vulnerability on the line below -->


## Description
<!-- Describe the security issue. What is the vulnerability? What is the potential impact? -->


## Steps to Reproduce
<!-- List the steps to reproduce the vulnerability -->
1.
2.
3.

## Affected Components
<!-- Which parts of swamp are affected? (CLI, runtime, API, extensions, etc.) -->


## Severity Assessment
<!-- Your assessment: low, medium, high, or critical -->


## Additional Context
<!-- Add any other context about the security issue here -->

`.trimStart();

/**
 * Parses the security report content from the editor.
 * Returns null if the content is empty or unchanged from the template.
 */
export function parseSecurityContent(
  content: string,
): { title: string; body: string } | null {
  const trimmedContent = content.trim();
  if (!trimmedContent || trimmedContent === SECURITY_TEMPLATE.trim()) {
    return null;
  }

  const titleMatch = content.match(
    /## Title\s*\n(?:<!--[^>]*-->\s*\n)?([^\n#<][^\n]*)/,
  );
  const title = titleMatch?.[1]?.trim();

  if (!title) {
    return null;
  }

  const descriptionIndex = content.indexOf("## Description");
  if (descriptionIndex === -1) {
    return { title, body: "" };
  }

  const body = content.substring(descriptionIndex);

  const cleanedBody = body
    .split("\n")
    .filter((line) => !line.match(/^\s*<!--.*-->\s*$/))
    .join("\n")
    .trim();

  return { title, body: cleanedBody };
}

export const issueSecurityCommand = new Command()
  .name("security")
  .description(
    "Submit a security vulnerability report (visible only to you and admins)",
  )
  .example("Submit a security report", "swamp issue security")
  .example(
    "Report a security vulnerability against an extension",
    "swamp issue security --extension @adam/cfgmgmt",
  )
  .option(
    "-t, --title <title:string>",
    "Vulnerability title (skips editor for title)",
  )
  .option(
    "-b, --body <body:string>",
    "Vulnerability description (requires --title, skips editor entirely)",
  )
  .option(
    "-e, --email",
    "Open email client with pre-filled security report",
  )
  .option(
    "-x, --extension <name:string>",
    "Route the security report against a specific extension (e.g. @adam/cfgmgmt)",
  )
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR) — only used with --extension",
  )
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, ["issue", "security"]);
    ctx.logger.debug`Submitting security report`;

    if (options.email && options.extension) {
      throw new UserError("--email and --extension cannot be used together.");
    }

    let extensionTarget: UsableExtensionTarget | undefined;
    if (options.extension) {
      const resolved = await resolveExtensionOrRefuse(
        ctx,
        options.extension,
        resolveRepoDir(options.repoDir),
      );
      if (resolved === null) return;
      extensionTarget = resolved;
    }

    const destination = !extensionTarget || extensionTarget.kind === "swamp-lab"
      ? await resolveDestination(ctx, options.email)
      : undefined;
    if (destination?.method === "abort") {
      await submitIssue(ctx, destination, {
        type: "security",
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
        prefix: "swamp-security-",
        suffix: ".md",
      });

      try {
        await Deno.writeTextFile(tempFile, SECURITY_TEMPLATE);
        ctx.logger.debug`Opening editor for security report`;
        await editorService.openFile(tempFile, { wait: true });

        const content = await Deno.readTextFile(tempFile);
        const parsed = parseSecurityContent(content);
        if (!parsed) {
          renderIssueCancelled(
            { type: "security", reason: "empty" },
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

    ctx.logger.debug`Submitting security report with title: ${title}`;

    if (extensionTarget?.kind === "repository") {
      await dispatchExtensionRepositoryReport(ctx, extensionTarget, {
        type: "security",
        title,
        body,
      });
      return;
    }

    await submitIssue(ctx, destination!, {
      type: "security",
      title,
      body,
      swampLabTarget: extensionTarget?.kind === "swamp-lab"
        ? extensionTarget
        : undefined,
    });

    ctx.logger.debug("Security report submitted successfully");
  });
