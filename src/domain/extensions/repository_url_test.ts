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

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { UserError } from "../errors.ts";
import {
  buildGithubAdvisoryUrl,
  buildGithubNewIssueUrl,
  buildGithubSecuritySettingsUrl,
  buildGitlabNewIssueUrl,
  parseRepositoryUrl,
  swampClubExtensionUrl,
} from "./repository_url.ts";

Deno.test("parseRepositoryUrl: github.com recognised", () => {
  const parsed = parseRepositoryUrl("https://github.com/adam/cfgmgmt");
  assertEquals(parsed.provider, "github");
  assertEquals(parsed.host, "github.com");
  assertEquals(parsed.ownerRepo, "adam/cfgmgmt");
});

Deno.test("parseRepositoryUrl: github.com with .git suffix stripped", () => {
  const parsed = parseRepositoryUrl("https://github.com/adam/cfgmgmt.git");
  assertEquals(parsed.ownerRepo, "adam/cfgmgmt");
  assertEquals(parsed.url, "https://github.com/adam/cfgmgmt");
});

Deno.test("parseRepositoryUrl: github.com with trailing slash stripped", () => {
  const parsed = parseRepositoryUrl("https://github.com/adam/cfgmgmt/");
  assertEquals(parsed.ownerRepo, "adam/cfgmgmt");
  assertEquals(parsed.url, "https://github.com/adam/cfgmgmt");
});

Deno.test("parseRepositoryUrl: github.com with deep path still extracts owner/repo", () => {
  const parsed = parseRepositoryUrl(
    "https://github.com/adam/cfgmgmt/tree/main/docs",
  );
  assertEquals(parsed.provider, "github");
  assertEquals(parsed.ownerRepo, "adam/cfgmgmt");
});

Deno.test("parseRepositoryUrl: gitlab.com recognised", () => {
  const parsed = parseRepositoryUrl("https://gitlab.com/group/proj");
  assertEquals(parsed.provider, "gitlab");
  assertEquals(parsed.ownerRepo, "group/proj");
});

Deno.test("parseRepositoryUrl: self-hosted GitLab becomes 'other'", () => {
  const parsed = parseRepositoryUrl("https://gitlab.company.com/group/proj");
  assertEquals(parsed.provider, "other");
  assertEquals(parsed.host, "gitlab.company.com");
  assertEquals(parsed.ownerRepo, undefined);
});

Deno.test("parseRepositoryUrl: bitbucket.org becomes 'other'", () => {
  const parsed = parseRepositoryUrl(
    "https://bitbucket.org/owner/repo",
  );
  assertEquals(parsed.provider, "other");
});

Deno.test("parseRepositoryUrl: rejects non-HTTPS URLs", () => {
  assertThrows(
    () => parseRepositoryUrl("http://github.com/adam/cfgmgmt"),
    UserError,
    "must use HTTPS",
  );
  assertThrows(
    () => parseRepositoryUrl("git@github.com:adam/cfgmgmt.git"),
    UserError,
  );
});

Deno.test("parseRepositoryUrl: rejects malformed URLs", () => {
  assertThrows(
    () => parseRepositoryUrl("not a url"),
    UserError,
    "Invalid repository URL",
  );
});

Deno.test("parseRepositoryUrl: host is lowercased", () => {
  const parsed = parseRepositoryUrl("https://GITHUB.com/adam/cfgmgmt");
  assertEquals(parsed.provider, "github");
  assertEquals(parsed.host, "github.com");
});

Deno.test("buildGithubNewIssueUrl: percent-encodes title and body", () => {
  const url = buildGithubNewIssueUrl(
    "adam/cfgmgmt",
    "Fails on `foo`",
    "Hello\n```js\ncode\n```",
  );
  // URLSearchParams uses '+' for spaces; also encodes backticks/newlines.
  assertStringIncludes(url, "title=Fails+on+%60foo%60");
  assertStringIncludes(url, "body=");
  assertEquals(
    url.startsWith("https://github.com/adam/cfgmgmt/issues/new?"),
    true,
  );
});

Deno.test("buildGithubNewIssueUrl: appends labels when provided", () => {
  const url = buildGithubNewIssueUrl(
    "adam/cfgmgmt",
    "t",
    "b",
    ["swamp-extension", "bug"],
  );
  assertStringIncludes(url, "labels=swamp-extension%2Cbug");
});

Deno.test("buildGithubNewIssueUrl: truncates oversize body with visible suffix", () => {
  const huge = "x".repeat(10_000);
  const url = buildGithubNewIssueUrl("adam/cfgmgmt", "t", huge);
  const params = new URL(url).searchParams;
  const body = params.get("body") ?? "";
  assertEquals(body.length < huge.length, true);
  assertStringIncludes(body, "body truncated");
});

Deno.test("buildGithubAdvisoryUrl: shape", () => {
  assertEquals(
    buildGithubAdvisoryUrl("adam/cfgmgmt"),
    "https://github.com/adam/cfgmgmt/security/advisories/new",
  );
});

Deno.test("buildGitlabNewIssueUrl: uses issue[title] and issue[description]", () => {
  const url = buildGitlabNewIssueUrl(
    "https://gitlab.com/group/proj",
    "Hello",
    "body",
  );
  assertStringIncludes(url, "/-/issues/new?");
  assertStringIncludes(url, "issue%5Btitle%5D=Hello");
  assertStringIncludes(url, "issue%5Bdescription%5D=body");
});

Deno.test("buildGitlabNewIssueUrl: strips trailing slash from repo URL", () => {
  const url = buildGitlabNewIssueUrl(
    "https://gitlab.com/group/proj/",
    "t",
    "b",
  );
  assertEquals(
    url.startsWith("https://gitlab.com/group/proj/-/issues/new?"),
    true,
  );
});

Deno.test("swampClubExtensionUrl: percent-encodes the scoped name", () => {
  assertEquals(
    swampClubExtensionUrl("@adam/cfgmgmt"),
    "https://swamp-club.com/extensions/%40adam%2Fcfgmgmt",
  );
});

Deno.test("buildGithubSecuritySettingsUrl: shape", () => {
  assertEquals(
    buildGithubSecuritySettingsUrl("adam/cfgmgmt"),
    "https://github.com/adam/cfgmgmt/settings/security_analysis",
  );
});
