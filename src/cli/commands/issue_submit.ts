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

/**
 * split in two phases so the auth check happens before the editor opens:
 * resolveDestination, then submitIssue.
 */

import type { CommandContext } from "../context.ts";
import type { OutputMode } from "../../presentation/output/output.ts";
import { consumeStream } from "../../libswamp/stream.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import {
  issueCreate,
  type IssueCreateDeps,
} from "../../libswamp/issues/create.ts";
import {
  createIssueCreateRenderer,
  renderExtensionRepositoryHandoff,
  renderIssueCancelled,
  renderRedactionNotice,
  renderRedactionSkipped,
} from "../../presentation/renderers/issue_create.ts";
import { AuthRepository } from "../../infrastructure/persistence/auth_repository.ts";
import { SwampClubClient } from "../../infrastructure/http/swamp_club_client.ts";
import { loadIdentity } from "../load_identity.ts";
import { openBrowser } from "../../infrastructure/process/browser.ts";
import { UserError } from "../../domain/errors.ts";
import type { AuthCredentials } from "../../domain/auth/auth_credentials.ts";
import { redactIssueTitleAndBody } from "../../domain/issues/content_redactor.ts";
import {
  type IssueFilingSource,
  parseIssueFilingSource,
} from "../../domain/issues/issue_source.ts";
import {
  chooseSubmittedContent,
  type RedactionConfirmDeps,
} from "./issue_redaction_confirm.ts";
import {
  type DispatcherDeps,
  dispatchRepositoryReport,
  type ExtensionTarget,
  type RefusalReason,
  resolveExtensionTarget,
} from "./extension_report_dispatcher.ts";
import { collectReporterContext } from "../../infrastructure/process/reporter_context_collector.ts";
import { VERSION } from "../../infrastructure/runtime/build_info.ts";

/** swamp-club refuses a blank title or body, so the request is never sent. */
export function requireNonBlank(flag: string, value: string): string {
  if (value.trim() === "") {
    throw new UserError(`${flag} must not be empty or only whitespace.`);
  }
  return value;
}

export type ReportTextSource =
  | { kind: "flags"; title: string; body: string }
  | { kind: "editor"; prefilledTitle?: string };

export function resolveReportText(
  options: { title?: string; body?: string },
  outputMode: OutputMode,
): ReportTextSource {
  if (options.title !== undefined && options.body !== undefined) {
    return {
      kind: "flags",
      title: requireNonBlank("--title", options.title),
      body: requireNonBlank("--body", options.body),
    };
  }
  if (options.body !== undefined) {
    throw new UserError("--body requires --title to be specified");
  }
  if (options.title !== undefined) {
    const title = requireNonBlank("--title", options.title);
    if (outputMode === "json") {
      throw new UserError(
        "--title requires --body with --json (interactive mode is not available).",
      );
    }
    // The report parsers read the title from one line that can't start with
    // "#" or "<", so such a title would make the edited report unreadable and
    // lose the body typed in the editor.
    if (title.includes("\n") || /^\s*[#<]/.test(title)) {
      throw new UserError(
        '--title without --body must be one line that does not start with "#" or "<". Pass --body as well, or type the title in the editor.',
      );
    }
    return { kind: "editor", prefilledTitle: title };
  }
  if (outputMode === "json") {
    throw new UserError(
      "Interactive mode is not available with --json. Use --title and --body options.",
    );
  }
  return { kind: "editor" };
}

export function prefillTitle(template: string, title?: string): string {
  if (title === undefined) {
    return template;
  }
  return template.replace(
    /(## Title\n<!--[^>]*-->\n)/,
    (section) => `${section}${title}\n`,
  );
}

/**
 * refuses a source alongside --extension, which routes a report elsewhere, and
 * --email, which has nowhere to carry it.
 */
export function resolveIssueSource(
  options: { source?: string; extension?: string; email?: boolean },
): IssueFilingSource | undefined {
  if (options.source === undefined) {
    return undefined;
  }
  if (options.extension !== undefined) {
    throw new UserError("--source and --extension cannot be used together.");
  }
  if (options.email) {
    throw new UserError("--source and --email cannot be used together.");
  }
  return parseIssueFilingSource(options.source);
}

export type UsableExtensionTarget = Exclude<
  ExtensionTarget,
  { kind: "refused" }
>;

const SUPPORT_EMAIL = "support@swamp-club.com";

export type SubmitDestination =
  | { method: "lab"; credentials: AuthCredentials }
  | { method: "email" }
  | { method: "abort" };

/**
 * call before opening the editor so the user isn't surprised. labOnly is for a
 * report email cannot carry: it is refused rather than offered the email
 * fallback.
 */
export async function resolveDestination(
  ctx: CommandContext,
  emailFlag?: boolean,
  forExtension = false,
  labOnly = false,
): Promise<SubmitDestination> {
  if (emailFlag) return { method: "email" };

  const authRepo = new AuthRepository();
  const credentials = await authRepo.load();
  if (credentials) return { method: "lab", credentials };

  if (labOnly) {
    throw notLoggedInError(true);
  }

  if (ctx.outputMode === "json") {
    throw notLoggedInError(forExtension);
  }

  const choice = await promptLoginOrEmail();
  if (choice === "login") return { method: "abort" };

  return { method: "email" };
}

export interface SubmitIssueInput {
  type: "bug" | "feature" | "security";
  title: string;
  body: string;
  source?: IssueFilingSource;
  noRedact?: boolean;
  /**
   * only passed on the @swamp/* path; third-party targets use
   * dispatchExtensionRepositoryReport and never reach submitIssue.
   */
  swampLabTarget?: Extract<UsableExtensionTarget, { kind: "swamp-lab" }>;
}

/**
 * --email is only suggested when it can be used: it is rejected alongside
 * --extension and --source.
 */
function notLoggedInError(emailRefused: boolean): UserError {
  return new UserError(
    emailRefused
      ? "Not logged in. Run `swamp auth login` first."
      : "Not logged in. Run `swamp auth login` first, or use --email.",
  );
}

export function buildMailtoUrl(
  type: "bug" | "feature" | "security",
  title: string,
  body: string,
): string {
  const subject = encodeURIComponent(`[${type}] ${title}`);
  const encodedBody = encodeURIComponent(body);
  return `mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${encodedBody}`;
}

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

/** the reason becomes the error code so --json callers can branch on it. */
function refusalError(
  extensionName: string,
  reason: RefusalReason,
  guidance: string,
): UserError {
  return new UserError(
    `Report not filed against ${extensionName}.\n\n${guidance}`,
    reason,
  );
}

/**
 * call before resolveDestination: refusals and repository handoffs need no Lab
 * auth, so checking it first would fail commands that never touch the Lab.
 */
export async function resolveExtensionOrRefuse(
  extensionName: string,
  repoDir: string,
): Promise<UsableExtensionTarget> {
  const target = await resolveExtensionTarget(repoDir, extensionName);
  if (target.kind === "refused") {
    throw refusalError(target.extensionName, target.reason, target.guidance);
  }
  return target;
}

export async function dispatchExtensionRepositoryReport(
  ctx: CommandContext,
  target: Extract<UsableExtensionTarget, { kind: "repository" }>,
  input: {
    type: "bug" | "feature" | "security";
    title: string;
    body: string;
    noRedact?: boolean;
  },
  deps: Omit<DispatcherDeps, "logger"> & { confirm?: RedactionConfirmDeps } =
    {},
): Promise<void> {
  const { confirm, ...dispatcherDeps } = deps;
  let title = input.title;
  let body = input.body;
  if (input.noRedact) {
    renderRedactionSkipped(ctx.outputMode);
  } else {
    const redacted = redactIssueTitleAndBody(input.title, input.body);
    renderRedactionNotice(redacted.summary, [
      { label: "title", result: redacted.title },
      { label: "body", result: redacted.body },
    ], ctx.outputMode);
    const chosen = await chooseSubmittedContent(
      redacted.summary,
      ctx.outputMode,
      {
        redacted: { title: redacted.title.text, body: redacted.body.text },
        original: { title, body },
      },
      confirm,
    );
    if (!chosen) {
      renderIssueCancelled(
        { type: input.type, reason: "cancelled" },
        ctx.outputMode,
      );
      return;
    }
    ({ title, body } = chosen);
  }

  const reporterContext = collectReporterContext({
    extensionName: target.extensionName,
    extensionVersion: target.extensionVersion,
    swampVersion: VERSION,
  });
  const result = await dispatchRepositoryReport(
    target,
    {
      type: input.type,
      title,
      body,
      reporterContext,
      outputMode: ctx.outputMode,
    },
    { ...dispatcherDeps, logger: ctx.logger },
  );
  if (result.kind === "refused") {
    throw refusalError(target.extensionName, result.reason, result.guidance);
  }
  renderExtensionRepositoryHandoff(
    { result, extensionName: target.extensionName },
    ctx.outputMode,
  );
}

export async function submitIssue(
  ctx: CommandContext,
  destination: SubmitDestination,
  input: SubmitIssueInput,
  promptDeps: { confirm?: RedactionConfirmDeps } = {},
): Promise<void> {
  const libCtx = createLibSwampContext({ logger: ctx.logger });
  const renderer = createIssueCreateRenderer(ctx.outputMode);

  if (destination.method === "abort") {
    throw notLoggedInError(input.swampLabTarget !== undefined);
  }

  if (input.noRedact) {
    renderRedactionSkipped(ctx.outputMode);
  } else {
    const redacted = redactIssueTitleAndBody(input.title, input.body);
    renderRedactionNotice(redacted.summary, [
      { label: "title", result: redacted.title },
      { label: "body", result: redacted.body },
    ], ctx.outputMode);
    const chosen = await chooseSubmittedContent(
      redacted.summary,
      ctx.outputMode,
      {
        redacted: { title: redacted.title.text, body: redacted.body.text },
        original: { title: input.title, body: input.body },
      },
      promptDeps.confirm,
    );
    if (!chosen) {
      renderIssueCancelled(
        { type: input.type, reason: "cancelled" },
        ctx.outputMode,
      );
      return;
    }
    input = { ...input, ...chosen };
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

  const identity = await loadIdentity();
  const client = new SwampClubClient(
    destination.credentials.serverUrl,
    identity,
  );
  const deps: IssueCreateDeps = {
    submitToLab: async (params) => {
      const result = await client.submitIssue(
        destination.credentials.apiKey,
        params,
      );
      return {
        number: result.number,
        url: `${destination.credentials.serverUrl}/lab/${result.number}`,
      };
    },
  };

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
      source: input.source,
    };

  try {
    await consumeStream(
      issueCreate(libCtx, deps, labInput),
      renderer.handlers(),
    );
  } catch (error) {
    if (error instanceof UserError && error.code === "timeout") {
      throw new UserError(
        input.source
          ? `${error.message} Your report has not been lost — retry.`
          : `${error.message} Your report has not been lost — retry, or use --email to send it via email instead.`,
        "timeout",
      );
    }
    throw error;
  }
}
