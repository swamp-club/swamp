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

import { bold, cyan, dim, green, red, yellow } from "@std/fmt/colors";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import type { AccessListCheckEntry } from "../../serve/oauth_access_list_resolution.ts";
import type { OutputMode } from "./output.ts";
import type { IneffectiveRestriction } from "../../domain/access/serve_auth_config.ts";
import type { GrantFileCheckIssue } from "../../domain/access/grant_file_loader.ts";

export interface ServeCheckConfigData {
  readonly passed: boolean;
  readonly authMode: "none" | "token" | "oauth";
  readonly oauthProvider?: string;
  readonly entries: readonly AccessListCheckEntry[];
  readonly allowedCollectives: readonly string[];
  readonly wouldStart: boolean;
  /**
   * why the auth settings would stop serve starting; an unusable token secrets
   * key is reported in tokenSecretsKey.error instead
   */
  readonly refusal?: string;
  readonly tokenSecretsKey?: TokenSecretsKeyCheck;
  /**
   * Advisory: restriction entries that restrict nothing as written, such as
   * a `restricted-commands` name that is not a server command. They do not
   * fail the check.
   */
  readonly restrictionWarnings?: readonly IneffectiveRestriction[];
  /**
   * Grant-file problems that would stop serve starting; any one fails the
   * check. Only grant files are read — stored grants are reported by serve
   * at startup.
   */
  readonly grantErrors?: readonly GrantFileCheckIssue[];
  readonly grantFilesChecked?: number;
  /**
   * advisory: grant type spellings that match no type as written, and grant
   * sources absent where the check ran; they do not fail the check
   */
  readonly grantWarnings?: readonly GrantFileCheckIssue[];
  /** advisory: route files a serve.yaml or --webhook route shadows */
  readonly webhookWarnings?: readonly WebhookRouteWarning[];
  /**
   * route files serve would refuse; serve still starts, but any one fails the
   * check so a bad file is caught before it reaches serve
   */
  readonly webhookRouteFileErrors?: readonly WebhookRouteFileError[];
  /** the routes directory is unusable; serve starts with no file routes */
  readonly webhookRoutesDirError?: string;
}

export interface WebhookRouteFileError {
  readonly file: string;
  readonly route?: string;
  readonly message: string;
}

export interface WebhookRouteWarning {
  readonly route: string;
  readonly workflow: string;
  readonly reason: string;
  readonly message: string;
}

/** Whether the external token secrets key resolves. Never holds the key. */
export interface TokenSecretsKeyCheck {
  readonly vault: string;
  readonly key: string;
  readonly status: "ok" | "failed";
  readonly error?: string;
}

const CHECKMARK = "✓";
const CROSS = "✗";
const ARROW = "→";

function entryLines(
  entries: readonly AccessListCheckEntry[],
  provider: string,
): string[] {
  return entries.map((e) =>
    e.status === "resolved"
      ? `  ${green(CHECKMARK)} ${e.entry} ${dim(`${ARROW} ${e.sub}`)}`
      : `  ${red(CROSS)} ${e.entry} ${red(`${ARROW} not found on ${provider}`)}`
  );
}

function grantIssueLocation(issue: GrantFileCheckIssue): string {
  return issue.entry !== undefined
    ? `${issue.file} entry ${issue.entry}`
    : issue.file;
}

export function renderServeCheckConfig(
  data: ServeCheckConfigData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    // deno-lint-ignore no-console
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const lines: string[] = [];
  lines.push(`${bold(cyan("Auth mode:"))} ${bold(data.authMode)}`);

  if (data.authMode !== "oauth" || data.oauthProvider === undefined) {
    lines.push(dim("  No usernames to resolve in this mode."));
  } else {
    const provider = data.oauthProvider;
    lines.push(`${bold(cyan("OAuth provider:"))} ${provider}`);

    const admins = data.entries.filter((e) => e.kind === "admin");
    const allowedUsers = data.entries.filter((e) => e.kind === "allowed-user");

    lines.push("");
    lines.push(cyan("Admins:"));
    lines.push(...entryLines(admins, provider));

    if (allowedUsers.length > 0) {
      lines.push("");
      lines.push(cyan("Allowed users:"));
      lines.push(...entryLines(allowedUsers, provider));
    }

    if (data.allowedCollectives.length > 0) {
      lines.push("");
      lines.push(
        `${cyan("Allowed collectives:")} ${data.allowedCollectives.join(", ")}`,
      );
    }
  }

  if (data.refusal !== undefined) {
    lines.push("");
    lines.push(`${red(CROSS)} ${red("swamp serve would refuse to start:")}`);
    lines.push(`  ${data.refusal}`);
  }

  const warnings = data.restrictionWarnings ?? [];
  if (warnings.length > 0) {
    lines.push("");
    lines.push(cyan("Restriction warnings:"));
    for (const warning of warnings) {
      lines.push(`  ${yellow("!")} ${warning.message}`);
    }
  }

  const webhookWarnings = data.webhookWarnings ?? [];
  if (webhookWarnings.length > 0) {
    lines.push("");
    lines.push(cyan("Webhook warnings:"));
    for (const warning of webhookWarnings) {
      lines.push(`  ${yellow("!")} ${warning.message}`);
    }
  }

  const routeFileErrors = data.webhookRouteFileErrors ?? [];
  const routesDirError = data.webhookRoutesDirError;
  if (routeFileErrors.length > 0 || routesDirError !== undefined) {
    lines.push("");
    lines.push(cyan("Webhook route file errors:"));
    if (routesDirError !== undefined) {
      lines.push(`  ${red(CROSS)} ${routesDirError}`);
    }
    for (const error of routeFileErrors) {
      lines.push(`  ${red(CROSS)} ${error.message}`);
    }
  }

  const grantErrors = data.grantErrors ?? [];
  const grantWarnings = data.grantWarnings ?? [];
  if (
    grantErrors.length === 0 && grantWarnings.length === 0 &&
    data.grantFilesChecked !== undefined
  ) {
    lines.push("");
    lines.push(
      `${cyan("Grant files:")} ${
        dim(`${data.grantFilesChecked} file(s) checked, no problems`)
      }`,
    );
  } else if (grantErrors.length > 0 || grantWarnings.length > 0) {
    lines.push("");
    lines.push(
      data.grantFilesChecked === undefined
        ? cyan("Grant files:")
        : `${cyan("Grant files:")} ${
          dim(`${data.grantFilesChecked} file(s) checked`)
        }`,
    );
    for (const issue of grantErrors) {
      lines.push(
        `  ${red(CROSS)} ${grantIssueLocation(issue)}: ${issue.message}`,
      );
    }
    for (const issue of grantWarnings) {
      lines.push(
        `  ${yellow("!")} ${grantIssueLocation(issue)}: ${issue.message}`,
      );
    }
  }

  const tokenKey = data.tokenSecretsKey;
  if (tokenKey) {
    lines.push("");
    lines.push(
      `${
        bold(cyan("Token secrets key:"))
      } vault ${tokenKey.vault}, key ${tokenKey.key}`,
    );
    lines.push(
      tokenKey.status === "ok"
        ? `  ${green(CHECKMARK)} resolves to a usable 32-byte key`
        : `  ${red(CROSS)} ${red(tokenKey.error ?? "not usable")}`,
    );
  }

  const notFound = data.entries.filter((e) => e.status === "not-found").length;
  let result = green("PASSED");
  if (!data.passed) {
    const startsWithout = [
      ...(notFound > 0 ? [`${notFound} unknown name(s)`] : []),
      ...(routesDirError !== undefined
        ? ["webhook routes directory refused"]
        : []),
      ...(routeFileErrors.length > 0
        ? [`${routeFileErrors.length} webhook route file(s) refused`]
        : []),
    ];
    const why = data.refusal !== undefined || tokenKey?.status === "failed" ||
        grantErrors.length > 0
      ? "swamp serve would refuse to start"
      : startsWithout.length > 0
      ? `${startsWithout.join(", ")}; swamp serve would start without them`
      : `${notFound} unknown name(s); swamp serve would start without them`;
    result = `${red("FAILED")} ${dim(`(${why})`)}`;
  }
  lines.push("");
  lines.push(`${bold(cyan("Result:"))} ${result}`);
  writeOutput(lines.join("\n"));
}
