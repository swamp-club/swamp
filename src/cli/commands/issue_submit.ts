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
 * Shared submission logic for `swamp issue bug`, `feature`, and `security`.
 *
 * Split into two phases so the auth check happens BEFORE the editor opens:
 * 1. resolveDestination() — check auth, prompt if needed, return where to send
 * 2. submitIssue() — send the issue to the resolved destination
 *
 * When `--extension` is supplied, submitIssue additionally resolves the
 * extension target (pulled/sourced/no-repo refusal vs @swamp-lab vs
 * third-party repository) and dispatches accordingly.
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
  renderExtensionRefusal,
  renderExtensionRepositoryHandoff,
} from "../../presentation/renderers/issue_create.ts";
import { AuthRepository } from "../../infrastructure/persistence/auth_repository.ts";
import { SwampClubClient } from "../../infrastructure/http/swamp_club_client.ts";
import { openBrowser } from "../../infrastructure/process/browser.ts";
import { UserError } from "../../domain/errors.ts";
import type { AuthCredentials } from "../../domain/auth/auth_credentials.ts";
import {
  dispatchRepositoryReport,
  type ExtensionTarget,
  resolveExtensionTarget,
} from "./extension_report_dispatcher.ts";
import { collectReporterContext } from "../../infrastructure/process/reporter_context_collector.ts";
import { VERSION } from "./version.ts";

/** Extension target after refusals have been rendered out — never "refused". */
export type UsableExtensionTarget = Exclude<
  ExtensionTarget,
  { kind: "refused" }
>;

const SUPPORT_EMAIL = "support@systeminit.com";

/** The resolved submission destination. */
export type SubmitDestination =
  | { method: "lab"; credentials: AuthCredentials }
  | { method: "email" }
  | { method: "abort" };

/**
 * Resolve where to send the issue BEFORE collecting content.
 * Call this before opening the editor so the user isn't surprised.
 */
export async function resolveDestination(
  ctx: CommandContext,
  emailFlag?: boolean,
): Promise<SubmitDestination> {
  if (emailFlag) return { method: "email" };

  const authRepo = new AuthRepository();
  const credentials = await authRepo.load();
  if (credentials) return { method: "lab", credentials };

  // Not logged in — prompt (interactive only)
  if (ctx.outputMode === "json") {
    throw new UserError(
      "Not logged in. Run `swamp auth login` first, or use --email.",
    );
  }

  const choice = await promptLoginOrEmail();
  if (choice === "login") return { method: "abort" };

  return { method: "email" };
}

export interface SubmitIssueInput {
  type: "bug" | "feature" | "security";
  title: string;
  body: string;
  /**
   * Pre-resolved `@swamp/*` target (from {@link resolveExtensionOrRefuse}).
   * Only passed on the `@swamp/*` extension path — third-party targets
   * use {@link dispatchExtensionRepositoryReport} directly and never
   * reach submitIssue.
   */
  swampLabTarget?: Extract<UsableExtensionTarget, { kind: "swamp-lab" }>;
}

/** Build a mailto: URL with pre-filled subject and body using RFC 6068 percent-encoding. */
export function buildMailtoUrl(
  type: "bug" | "feature" | "security",
  title: string,
  body: string,
): string {
  const subject = encodeURIComponent(`[${type}] ${title}`);
  const encodedBody = encodeURIComponent(body);
  return `mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${encodedBody}`;
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
      "\nYou're not logged in to swamp-club.com.\n\n" +
        "  1. Log in first (then retry this command)\n" +
        "  2. Send via email\n\n" +
        "Choose [1/2]: ",
    ),
  );

  const buf = new Uint8Array(64);
  const n = await Deno.stdin.read(buf);
  const answer = n ? decoder.decode(buf.subarray(0, n)).trim() : "";

  if (answer === "1" || answer === "l" || answer === "login") return "login";
  if (answer === "2" || answer === "e" || answer === "email") return "email";
  // Default to login (safer — doesn't send content externally)
  return "login";
}

/**
 * Extension pre-flight: resolves the target, renders any refusal, and
 * returns a usable target for the caller to act on. Returns null when
 * the refusal was rendered and the subcommand should exit.
 *
 * Call this BEFORE {@link resolveDestination} — refusals and repository
 * handoffs don't need Lab auth, so auth-checking the user up-front would
 * spuriously fail commands that were never going to touch the Lab.
 */
export async function resolveExtensionOrRefuse(
  ctx: CommandContext,
  extensionName: string,
  repoDir: string,
): Promise<UsableExtensionTarget | null> {
  const target = await resolveExtensionTarget(repoDir, extensionName);
  if (target.kind === "refused") {
    renderExtensionRefusal(
      {
        extensionName: target.extensionName,
        reason: target.reason,
        guidance: target.guidance,
      },
      ctx.outputMode,
    );
    return null;
  }
  return target;
}

/**
 * Dispatches a report to the publisher's declared repository via gh or
 * browser handoff, then renders the completion event. Used by all three
 * subcommands once the body has been collected.
 */
export async function dispatchExtensionRepositoryReport(
  ctx: CommandContext,
  target: Extract<UsableExtensionTarget, { kind: "repository" }>,
  input: { type: "bug" | "feature" | "security"; title: string; body: string },
): Promise<void> {
  const reporterContext = collectReporterContext({
    extensionName: target.extensionName,
    extensionVersion: target.extensionVersion,
    swampVersion: VERSION,
  });
  const result = await dispatchRepositoryReport(
    target,
    {
      type: input.type,
      title: input.title,
      body: input.body,
      reporterContext,
      outputMode: ctx.outputMode,
    },
    { logger: ctx.logger },
  );
  renderExtensionRepositoryHandoff(
    { result, extensionName: target.extensionName },
    ctx.outputMode,
  );
}

/**
 * Submit an issue to the already-resolved destination. Called after
 * title/body are collected for the plain (non-extension) path and for
 * the `@swamp/*` extension path (both of which need Lab auth).
 *
 * For the plain path, `input.extensionName` is unset.
 * For the `@swamp/*` path, `input.extensionName` is set and libswamp
 * appends extension metadata to the body.
 */
export async function submitIssue(
  ctx: CommandContext,
  destination: SubmitDestination,
  input: SubmitIssueInput,
): Promise<void> {
  const libCtx = createLibSwampContext({ logger: ctx.logger });
  const renderer = createIssueCreateRenderer(ctx.outputMode);

  if (destination.method === "abort") {
    libCtx.logger
      .info`Run "swamp auth login" first, then retry this command.`;
    return;
  }

  if (destination.method === "email") {
    if (input.type === "security") {
      libCtx.logger
        .info`Note: email submissions are not private. For confidential reporting, log in and use the Lab.`;
    }
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

  // Lab submission (both plain and @swamp-extension paths).
  const client = new SwampClubClient(destination.credentials.serverUrl);
  const deps: IssueCreateDeps = {
    submitToLab: async (params) => {
      const result = await client.submitIssue(
        destination.credentials.apiKey,
        params,
      );
      return {
        number: result.number,
        serverUrl: destination.credentials.serverUrl,
      };
    },
  };

  // @swamp path: populate the extension metadata so libswamp assembles
  // the body with Extension: / Upstream repository: / Environment lines.
  const labInput = input.swampLabTarget
    ? {
      type: input.type,
      title: input.title,
      body: input.body,
      extensionName: input.swampLabTarget.extensionName,
      extensionVersion: input.swampLabTarget.extensionVersion,
      repositoryUrl: input.swampLabTarget.repositoryUrl,
      reporterContext: collectReporterContext({
        extensionName: input.swampLabTarget.extensionName,
        extensionVersion: input.swampLabTarget.extensionVersion,
        swampVersion: VERSION,
      }),
    }
    : {
      type: input.type,
      title: input.title,
      body: input.body,
    };

  await consumeStream(
    issueCreate(libCtx, deps, labInput),
    renderer.handlers(),
  );
}
