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

import { assertEquals } from "@std/assert";
import { GitHubIssueService } from "./github_issue_service.ts";

Deno.test("issue URL parsing extracts issue number", () => {
  const url = "https://github.com/systeminit/swamp/issues/123";
  const match = url.match(/\/issues\/(\d+)$/);
  const number = match ? parseInt(match[1], 10) : 0;
  assertEquals(number, 123);
});

Deno.test("issue URL parsing handles different repos", () => {
  const url = "https://github.com/owner/repo/issues/456";
  const match = url.match(/\/issues\/(\d+)$/);
  const number = match ? parseInt(match[1], 10) : 0;
  assertEquals(number, 456);
});

Deno.test("issue URL parsing returns 0 for invalid URL", () => {
  const url = "not-a-valid-url";
  const match = url.match(/\/issues\/(\d+)$/);
  const number = match ? parseInt(match[1], 10) : 0;
  assertEquals(number, 0);
});

Deno.test("getNewIssueUrl uses default repo with labels", () => {
  const service = new GitHubIssueService();
  const url = service.getNewIssueUrl({ labels: ["bug", "needs-triage"] });
  assertEquals(
    url,
    "https://github.com/systeminit/swamp/issues/new?labels=bug%2Cneeds-triage",
  );
});

Deno.test("getNewIssueUrl uses custom repo", () => {
  const service = new GitHubIssueService();
  const url = service.getNewIssueUrl({
    repo: "owner/other-repo",
    labels: ["feature"],
  });
  assertEquals(
    url,
    "https://github.com/owner/other-repo/issues/new?labels=feature",
  );
});

Deno.test("getNewIssueUrl with no labels omits query string", () => {
  const service = new GitHubIssueService();
  const url = service.getNewIssueUrl({ labels: [] });
  assertEquals(url, "https://github.com/systeminit/swamp/issues/new");
});
