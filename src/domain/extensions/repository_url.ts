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

import { UserError } from "../errors.ts";
import { DEFAULT_SWAMP_CLUB_URL } from "../auth/auth_credentials.ts";

export type RepositoryProvider = "github" | "gitlab" | "other";

export interface ParsedRepositoryUrl {
  provider: RepositoryProvider;
  host: string;
  ownerRepo?: string;
  url: string;
}

/**
 * truncate conservatively below GitHub's pre-fill limit so percent-encoding
 * does not push the URL over it
 */
const URL_BODY_MAX_LEN = 7000;
const URL_BODY_TRUNCATION_SUFFIX = "\n\n…(body truncated; see terminal output)";

/**
 * only HTTPS URLs are accepted: git@ style URLs cannot be opened in a browser
 * and are rejected so the caller surfaces the right guidance
 */
export function parseRepositoryUrl(url: string): ParsedRepositoryUrl {
  rejectInvisibleCharacters(url);

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UserError(
      `Invalid repository URL: "${url}". Must be an HTTPS URL.`,
    );
  }
  if (parsed.protocol !== "https:") {
    throw new UserError(
      `Repository URL must use HTTPS: "${url}". ` +
        `Opening non-HTTPS URLs in a browser isn't supported.`,
    );
  }

  const canonical = canonicaliseUrl(parsed);
  const host = parsed.hostname.toLowerCase();

  if (host === "github.com") {
    const ownerRepo = extractOwnerRepo(parsed);
    if (ownerRepo) {
      return { provider: "github", host, ownerRepo, url: canonical };
    }
  }

  if (host === "gitlab.com") {
    const ownerRepo = extractOwnerRepo(parsed);
    if (ownerRepo) {
      return { provider: "gitlab", host, ownerRepo, url: canonical };
    }
  }

  return { provider: "other", host, url: canonical };
}

export function buildGithubNewIssueUrl(
  ownerRepo: string,
  title: string,
  body: string,
  labels: string[] = [],
): string {
  const safeBody = truncateForUrl(body);
  const params = new URLSearchParams();
  params.set("title", title);
  params.set("body", safeBody);
  if (labels.length > 0) params.set("labels", labels.join(","));
  return `https://github.com/${ownerRepo}/issues/new?${params.toString()}`;
}

/**
 * GitHub's advisory form takes no URL query parameters, so the CLI hands off to
 * this URL and the user fills in the form
 */
export function buildGithubAdvisoryUrl(ownerRepo: string): string {
  return `https://github.com/${ownerRepo}/security/advisories/new`;
}

export function buildGitlabNewIssueUrl(
  repoUrl: string,
  title: string,
  body: string,
): string {
  const safeBody = truncateForUrl(body);
  const base = repoUrl.replace(/\/$/, "");
  const params = new URLSearchParams();
  params.set("issue[title]", title);
  params.set("issue[description]", safeBody);
  return `${base}/-/issues/new?${params.toString()}`;
}

/**
 * centralised so swamp-club route changes land in one place; the template
 * matches swamp-club's extensions route
 */
export function swampClubExtensionUrl(extensionName: string): string {
  return `${DEFAULT_SWAMP_CLUB_URL}/extensions/${
    encodeURIComponent(extensionName)
  }`;
}

/**
 * only useful to the repo's admin, but included in refusal guidance so
 * publishers have a one-click action when a reporter forwards it
 */
export function buildGithubSecuritySettingsUrl(ownerRepo: string): string {
  return `https://github.com/${ownerRepo}/settings/security_analysis`;
}

function truncateForUrl(body: string): string {
  if (body.length <= URL_BODY_MAX_LEN) return body;
  const head = body.slice(
    0,
    URL_BODY_MAX_LEN - URL_BODY_TRUNCATION_SUFFIX.length,
  );
  return head + URL_BODY_TRUNCATION_SUFFIX;
}

function canonicaliseUrl(parsed: URL): string {
  let pathname = parsed.pathname.replace(/\/+$/, "");
  if (pathname.endsWith(".git")) pathname = pathname.slice(0, -4);
  return `${parsed.protocol}//${parsed.host}${pathname}`;
}

function extractOwnerRepo(parsed: URL): string | undefined {
  const cleaned = parsed.pathname.replace(/^\/+/, "").replace(/\.git$/, "");
  if (!cleaned) return undefined;
  const segments = cleaned.split("/").filter((s) => s.length > 0);
  if (segments.length < 2) return undefined;
  return `${segments[0]}/${segments[1]}`;
}

// deno-lint-ignore no-control-regex
const INVISIBLE_CHAR_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\t\n\r]/;

/**
 * the WHATWG URL parser silently strips tabs and newlines, which corrupts the
 * extracted owner/repo (f\tveronezzi becomes fveronezzi)
 */
function rejectInvisibleCharacters(url: string): void {
  const match = INVISIBLE_CHAR_PATTERN.exec(url);
  if (match) {
    const codePoint = match[0].codePointAt(0)!;
    const position = match.index;
    throw new UserError(
      `Repository URL contains an invisible character ` +
        `(U+${codePoint.toString(16).toUpperCase().padStart(4, "0")} ` +
        `at position ${position}): "${url}". ` +
        `This corrupts issue routing. The extension publisher needs to ` +
        `fix the \`repository\` field in their manifest.yaml and re-push. ` +
        `As a workaround, file the issue directly via ` +
        `\`gh issue create --repo <owner>/<repo>\`.`,
    );
  }
}
