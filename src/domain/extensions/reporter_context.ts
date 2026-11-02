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
 * the field list is narrow on purpose: this data ships to third-party repos, so
 * extending it widens a trust boundary and must be an explicit decision
 */
export interface ReporterContext {
  extensionName: string;
  extensionVersion: string;
  swampVersion: string;
  os: string;
  arch: string;
  shell: string;
  denoVersion: string;
}

export function formatReporterContextMarkdown(ctx: ReporterContext): string {
  return [
    "## Environment",
    `- Extension: \`${ctx.extensionName}@${ctx.extensionVersion}\``,
    `- swamp: \`${ctx.swampVersion}\``,
    `- OS: \`${ctx.os}\` (${ctx.arch})`,
    `- Deno: \`${ctx.denoVersion}\``,
    `- Shell: \`${ctx.shell}\``,
  ].join("\n");
}

/**
 * shared by the @swamp Lab path and the third-party repository path so both
 * destinations produce identical formatting
 */
export function assembleExtensionReportBody(
  userBody: string,
  repositoryUrl: string | undefined,
  reporterContext: ReporterContext,
): string {
  const parts: string[] = [userBody.trimEnd(), ""];
  if (repositoryUrl) {
    parts.push(`Upstream repository: ${repositoryUrl}`);
    parts.push("");
  }
  parts.push(formatReporterContextMarkdown(reporterContext));
  return parts.join("\n");
}
