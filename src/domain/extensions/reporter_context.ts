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
 * Reproducibility context attached to every extension-scoped issue
 * report so the publisher sees which version / runtime the reporter hit
 * the bug on.
 *
 * The field list is intentionally narrow — extending it widens a trust
 * boundary (this data is shipped to third-party repos) and must be an
 * explicit decision, not an incidental one.
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

/**
 * Renders the reporter context as a Markdown section suitable for
 * appending to the body of an issue. The "## Environment" header shape
 * mirrors the existing bug/security templates so users who know those
 * see something familiar.
 */
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
 * Assembles the final issue body for an extension-scoped report.
 *
 * Shared by the @swamp Lab path (libswamp) and the third-party
 * repository path (CLI dispatcher) so the two destinations produce
 * identical formatting — readers comparing an @swamp report to a
 * third-party one shouldn't find cosmetic drift.
 *
 * Layout:
 *   <user body>
 *
 *   Upstream repository: <url>        ← only when repositoryUrl is set
 *
 *   ## Environment
 *   - Extension: `@name@version`
 *   - swamp: ...
 *   - ...
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
