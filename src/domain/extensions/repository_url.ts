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

import { UserError } from "../errors.ts";
import { DEFAULT_SWAMP_CLUB_URL } from "../auth/auth_credentials.ts";

/** Supported third-party repository providers. */
export type RepositoryProvider = "github" | "gitlab" | "other";

/** Parsed view of a manifest `repository` URL. */
export interface ParsedRepositoryUrl {
  provider: RepositoryProvider;
  host: string;
  /** "owner/repo" for GitHub/GitLab; undefined for "other". */
  ownerRepo?: string;
  /** The original URL, canonicalised (trailing slash and `.git` stripped). */
  url: string;
}

/**
 * GitHub URLs pre-fill title/body in the issue-new page up to ~8KB — truncate
 * conservatively well under that so percent-encoding doesn't push us over.
 */
const URL_BODY_MAX_LEN = 7000;
const URL_BODY_TRUNCATION_SUFFIX = "\n\n…(body truncated; see terminal output)";

/**
 * Parses a repository URL from an extension manifest.
 *
 * Only HTTPS URLs are accepted — `git@github.com:...` style URLs cannot be
 * opened in a browser and are rejected with a clear error so the caller
 * surfaces the right guidance.
 */
export function parseRepositoryUrl(url: string): ParsedRepositoryUrl {
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

/**
 * Builds the pre-filled GitHub new-issue URL. Body is truncated with a
 * visible suffix if it would otherwise blow past GitHub's URL-length cap.
 */
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
 * Builds the GitHub private vulnerability reporting URL. GitHub's advisory
 * form is structured and does not accept URL query parameters — the CLI
 * hands off to this URL and the user fills in the form.
 */
export function buildGithubAdvisoryUrl(ownerRepo: string): string {
  return `https://github.com/${ownerRepo}/security/advisories/new`;
}

/** Builds the pre-filled GitLab new-issue URL (gitlab.com only). */
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
 * Centralises the swamp-club extension-page URL so future swamp-club
 * route changes land in one place. The URL template matches
 * swamp-club/routes/extensions/[...name].tsx.
 */
export function swampClubExtensionUrl(extensionName: string): string {
  return `${DEFAULT_SWAMP_CLUB_URL}/extensions/${
    encodeURIComponent(extensionName)
  }`;
}

/**
 * Builds the GitHub "enable private vulnerability reporting" repo-settings
 * URL. Only useful to the repo's admin, but included in the refusal
 * guidance so publishers have a one-click action when a reporter forwards
 * the message to them.
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
  // Strip leading "/", drop trailing ".git", then take the first two segments.
  const cleaned = parsed.pathname.replace(/^\/+/, "").replace(/\.git$/, "");
  if (!cleaned) return undefined;
  const segments = cleaned.split("/").filter((s) => s.length > 0);
  if (segments.length < 2) return undefined;
  return `${segments[0]}/${segments[1]}`;
}
