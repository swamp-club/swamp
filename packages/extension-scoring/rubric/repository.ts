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
 * The `repository-verified` factor's inputs: the repository URL forms the
 * registry can verify, and what each side knows about verification.
 */

/** A source host the registry verifies repositories on. */
export type VcsHost = "github" | "gitlab" | "codeberg" | "bitbucket";

/** A repository URL reduced to its host, owner and name. */
export interface ParsedVcsUrl {
  host: VcsHost;
  owner: string;
  repo: string;
}

const HOSTNAME_TO_VCS: Record<string, VcsHost> = {
  "github.com": "github",
  "gitlab.com": "gitlab",
  "codeberg.org": "codeberg",
  "bitbucket.org": "bitbucket",
};

const DEEP_LINK_SEGMENTS = new Set([
  "tree",
  "blob",
  "pull",
  "pulls",
  "issues",
  "merge_requests",
  "-", // GitLab's web UI prefixes `/:owner/:repo/-/` for nested routes
  "commits",
  "commit",
  "releases",
  "tags",
  "wiki",
  "actions",
  "src",
]);

/**
 * Parses a repository URL the registry can verify: HTTPS, on one of the
 * {@link VcsHost}s, naming an owner and a repository (a deep link such as
 * `/tree/main` is cut off). Null for anything else.
 */
export function parseVcsUrl(raw: string): ParsedVcsUrl | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol !== "https:") return null;

  const host = HOSTNAME_TO_VCS[url.hostname.toLowerCase()];
  if (!host) return null;

  const rawPath = url.pathname;
  let path = rawPath.replace(/^\/+/, "").replace(/\/+$/, "");
  if (path.endsWith(".git")) path = path.slice(0, -".git".length);

  const allSegments = path.split("/").filter((s) => s.length > 0);
  if (allSegments.length < 2) return null;

  let cutoff = allSegments.length;
  for (let i = 2; i < allSegments.length; i++) {
    if (DEEP_LINK_SEGMENTS.has(allSegments[i].toLowerCase())) {
      cutoff = i;
      break;
    }
  }
  const segments = allSegments.slice(0, cutoff);
  if (segments.length < 2) return null;

  if (host === "gitlab") {
    // GitLab supports nested groups: everything except the last segment
    // is the owner path.
    const repo = stripDotGit(segments[segments.length - 1]);
    const owner = segments.slice(0, -1).join("/");
    if (!owner || !repo) return null;
    if (!isValidPathComponent(owner) || !isValidPathComponent(repo)) {
      return null;
    }
    return { host, owner, repo };
  }

  const owner = segments[0];
  const repo = stripDotGit(segments[1]);
  if (!owner || !repo) return null;
  if (!isValidPathComponent(owner) || !isValidPathComponent(repo)) {
    return null;
  }
  return { host, owner, repo };
}

function stripDotGit(s: string): string {
  return s.endsWith(".git") ? s.slice(0, -".git".length) : s;
}

function isValidPathComponent(s: string): boolean {
  if (s.length === 0) return false;
  return /^[A-Za-z0-9_./-]+$/.test(s);
}

/**
 * Whether the registry will award `repository-verified` through the
 * collective's private source hosting, as far as the CLI can tell before
 * publish. The registry awards it to a private extension whose collective
 * has private source hosting, whatever the repository URL.
 *   attested     → the registry awards the factor
 *   not_attested → it does not; `reason` says which half is missing
 *   unknown      → the CLI could not tell (no credentials, swamp-club
 *                  unreachable, or a server that does not report it), so
 *                  the factor is scored on the repository URL alone
 */
export type PrivateSourceStanding =
  | { kind: "attested" }
  | {
    kind: "not_attested";
    reason: "public_extension" | "no_private_source_hosting";
  }
  | { kind: "unknown" };

/**
 * What the scorer knows about `repository-verified`.
 *   confirmed → the registry's own result: whether it verified a public
 *               repository, and whether the extension is private with a
 *               collective that has private source hosting
 *   predicted → before publish: the manifest's repository URL and the
 *               private source standing; the factor is provisional when the
 *               registry would award it, since only the registry decides
 */
export type RepositoryEvidence =
  | {
    kind: "confirmed";
    publicRepositoryVerified: boolean;
    privateSourceAttested: boolean;
  }
  | {
    kind: "predicted";
    repository: string | undefined;
    privateSource: PrivateSourceStanding;
  };
