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

/**
 * Shared submission logic for `swamp issue bug` and `swamp issue feature`.
 *
 * Orchestrates the submission path:
 * 1. --email flag → open mailto: link
 * 2. Logged in → submit to Lab API
 * 3. Not logged in → prompt: log in or email
 */

import type { CommandContext } from "../context.ts";
import {
  consumeStream,
  createLibSwampContext,
  issueCreate,
  type IssueCreateDeps,
} from "../../libswamp/mod.ts";
import {
  createIssueCreateRenderer,
} from "../../presentation/renderers/issue_create.ts";
import { AuthRepository } from "../../infrastructure/persistence/auth_repository.ts";
import { SwampClubClient } from "../../infrastructure/http/swamp_club_client.ts";
import { openBrowser } from "../../infrastructure/process/browser.ts";
import { UserError } from "../../domain/errors.ts";

const SUPPORT_EMAIL = "support@systeminit.com";

interface SubmitIssueInput {
  type: "bug" | "feature";
  title: string;
  body: string;
  email?: boolean;
}

/** Build a mailto: URL with pre-filled subject and body. */
function buildMailtoUrl(
  type: "bug" | "feature",
  title: string,
  body: string,
): string {
  const subject = `[${type}] ${title}`;
  const params = new URLSearchParams({ subject, body });
  return `mailto:${SUPPORT_EMAIL}?${params.toString()}`;
}

/**
 * Prompt the user to choose between logging in or sending email.
 * Returns "login" or "email".
 */
async function promptLoginOrEmail(): Promise<"login" | "email"> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  await Deno.stdout.write(
    encoder.encode(
      "\nYou're not logged in to swamp.club.\n\n" +
        "  1. Log in now (run `swamp auth login` first, then retry)\n" +
        "  2. Send via email\n\n" +
        "Choose [1/2]: ",
    ),
  );

  const buf = new Uint8Array(64);
  const n = await Deno.stdin.read(buf);
  const answer = n ? decoder.decode(buf.subarray(0, n)).trim() : "";

  return answer === "1" ? "login" : "email";
}

/**
 * Submit an issue through the appropriate channel.
 * Called by both issue_bug.ts and issue_feature.ts after title/body are collected.
 */
export async function submitIssue(
  ctx: CommandContext,
  input: SubmitIssueInput,
): Promise<void> {
  const libCtx = createLibSwampContext({ logger: ctx.logger });
  const renderer = createIssueCreateRenderer(ctx.outputMode);

  // --email flag: short-circuit to email
  if (input.email) {
    const mailtoUrl = buildMailtoUrl(input.type, input.title, input.body);
    await openBrowser(mailtoUrl);
    await consumeStream(
      (async function* () {
        yield {
          kind: "completed" as const,
          data: {
            method: "email" as const,
            mailtoUrl,
            type: input.type,
            title: input.title,
          },
        };
      })(),
      renderer.handlers(),
    );
    return;
  }

  // Check for auth credentials
  const authRepo = new AuthRepository();
  const credentials = await authRepo.load();

  if (credentials) {
    // Logged in → submit to Lab
    const client = new SwampClubClient(credentials.serverUrl);
    const deps: IssueCreateDeps = {
      submitToLab: async (params) => {
        const result = await client.submitIssue(credentials.apiKey, params);
        return { number: result.number, serverUrl: credentials.serverUrl };
      },
    };

    await consumeStream(
      issueCreate(libCtx, deps, input),
      renderer.handlers(),
    );
    return;
  }

  // Not logged in — prompt (interactive only)
  if (ctx.outputMode === "json") {
    throw new UserError(
      "Not logged in. Run `swamp auth login` first, or use --email.",
    );
  }

  const choice = await promptLoginOrEmail();

  if (choice === "login") {
    const logger = createLibSwampContext({ logger: ctx.logger });
    logger.logger.info`Run "swamp auth login" first, then retry this command.`;
    return;
  }

  // Email fallback
  const mailtoUrl = buildMailtoUrl(input.type, input.title, input.body);
  await openBrowser(mailtoUrl);
  await consumeStream(
    (async function* () {
      yield {
        kind: "completed" as const,
        data: {
          method: "email" as const,
          mailtoUrl,
          type: input.type,
          title: input.title,
        },
      };
    })(),
    renderer.handlers(),
  );
}
