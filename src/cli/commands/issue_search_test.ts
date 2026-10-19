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

import { assertEquals, assertThrows } from "@std/assert";
import { UserError } from "../../domain/errors.ts";
import {
  issueSearchCommand,
  validateIssueSearchOptions,
} from "./issue_search.ts";

Deno.test("issueSearchCommand: has correct name and description", () => {
  assertEquals(issueSearchCommand.getName(), "search");
  assertEquals(
    issueSearchCommand.getDescription(),
    "Search or list swamp-club Lab issues",
  );
});

Deno.test("validateIssueSearchOptions: accepts every value the Lab accepts", () => {
  validateIssueSearchOptions({});
  for (const type of ["bug", "feature", "security", "platform"]) {
    validateIssueSearchOptions({ type });
  }
  for (
    const status of ["open", "triaged", "in_progress", "shipped", "closed"]
  ) {
    validateIssueSearchOptions({ status });
  }
  validateIssueSearchOptions({ limit: 1 });
  validateIssueSearchOptions({ limit: 1000 });
});

Deno.test("validateIssueSearchOptions: rejects an unknown --type", () => {
  for (const type of ["bogus", "BUG", ""]) {
    const error = assertThrows(
      () => validateIssueSearchOptions({ type }),
      UserError,
    );
    assertEquals(
      error.message,
      `Invalid issue type "${type}". Must be one of: bug, feature, security, platform`,
    );
  }
});

Deno.test("validateIssueSearchOptions: rejects an unknown --status", () => {
  for (const status of ["bogus", "done", "OPEN"]) {
    const error = assertThrows(
      () => validateIssueSearchOptions({ status }),
      UserError,
    );
    assertEquals(
      error.message,
      `Invalid issue status "${status}". Must be one of: open, triaged, in_progress, shipped, closed`,
    );
  }
});

Deno.test("validateIssueSearchOptions: rejects a --limit below 1", () => {
  for (const limit of [0, -1]) {
    const error = assertThrows(
      () => validateIssueSearchOptions({ limit }),
      UserError,
    );
    assertEquals(
      error.message,
      `Invalid limit ${limit}. Must be a positive integer.`,
    );
  }
});
