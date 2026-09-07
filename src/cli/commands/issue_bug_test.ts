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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { buildBugTemplate, parseBugContent } from "./issue_bug.ts";

Deno.test("parseBugContent: returns null for empty content", () => {
  const template = buildBugTemplate();
  const result = parseBugContent("", template);
  assertEquals(result, null);
});

Deno.test("parseBugContent: returns null for unchanged template", () => {
  const template = buildBugTemplate();
  const result = parseBugContent(template, template);
  assertEquals(result, null);
});

Deno.test("parseBugContent: extracts title and body", () => {
  const template = buildBugTemplate();
  const content = `
# Bug Report

## Title
<!-- Enter a brief, descriptive title for the bug on the line below -->
CLI crashes when running without arguments

## Description
<!-- Describe the bug in detail. What did you expect to happen? What actually happened? -->
When I run swamp without any arguments, it crashes.

## Steps to Reproduce
<!-- List the steps to reproduce the bug -->
1. Run swamp
2. See crash

## Environment
<!-- Include relevant environment information -->
- swamp version: 1.0.0
- OS: macOS
- Shell: zsh

## Additional Context
<!-- Add any other context about the problem here -->
None
`.trimStart();

  const result = parseBugContent(content, template);
  assertEquals(result?.title, "CLI crashes when running without arguments");
  assertEquals(result?.body.includes("When I run swamp"), true);
  assertEquals(result?.body.startsWith("## Description"), true);
});

Deno.test("parseBugContent: returns null when no title provided", () => {
  const template = buildBugTemplate();
  const content = `
# Bug Report

## Title
<!-- Enter a brief, descriptive title for the bug on the line below -->


## Description
Some description here
`.trimStart();

  const result = parseBugContent(content, template);
  assertEquals(result, null);
});

Deno.test("parseBugContent: handles title with only whitespace after", () => {
  const template = buildBugTemplate();
  const content = `
# Bug Report

## Title
My bug title

## Description
Bug description
`.trimStart();

  const result = parseBugContent(content, template);
  assertEquals(result?.title, "My bug title");
  assertEquals(result?.body.includes("Bug description"), true);
});

Deno.test("buildBugTemplate: auto-populates environment values", () => {
  const template = buildBugTemplate();
  assertStringIncludes(template, `- OS: ${Deno.build.os}`);
  assertStringIncludes(
    template,
    `- Shell: ${Deno.env.get("SHELL") ?? "unknown"}`,
  );
  assertStringIncludes(template, "- swamp version: ");
  // Version is non-empty
  const versionMatch = template.match(/- swamp version: (.+)/);
  assertEquals(versionMatch !== null, true);
  assertEquals(versionMatch![1].trim().length > 0, true);
});
