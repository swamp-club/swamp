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

import { assertEquals } from "@std/assert";

// Re-export the parse function for testing by copying the logic
// (since the original is not exported)

/**
 * Template for bug reports (copied from issue_bug.ts for testing).
 */
const BUG_TEMPLATE = `
# Bug Report

## Title
<!-- Enter a brief, descriptive title for the bug on the line below -->


## Description
<!-- Describe the bug in detail. What did you expect to happen? What actually happened? -->


## Steps to Reproduce
<!-- List the steps to reproduce the bug -->
1.
2.
3.

## Environment
<!-- Include relevant environment information -->
- swamp version:
- OS:
- Shell:

## Additional Context
<!-- Add any other context about the problem here -->

`.trimStart();

/**
 * Parses the bug report content from the editor.
 * Returns null if the content is empty or unchanged from the template.
 */
function parseBugContent(
  content: string,
): { title: string; body: string } | null {
  // Check if content is essentially empty or unchanged
  const trimmedContent = content.trim();
  if (!trimmedContent || trimmedContent === BUG_TEMPLATE.trim()) {
    return null;
  }

  // Extract title from the "## Title" section
  // Title must be a single line that doesn't start with # or <!--
  const titleMatch = content.match(
    /## Title\s*\n(?:<!--[^>]*-->\s*\n)?([^\n#<][^\n]*)/,
  );
  const title = titleMatch?.[1]?.trim();

  if (!title) {
    return null;
  }

  // Build body from remaining sections (everything after ## Description)
  const descriptionIndex = content.indexOf("## Description");
  if (descriptionIndex === -1) {
    return { title, body: "" };
  }

  const body = content.substring(descriptionIndex);

  // Clean up the body by removing HTML comment lines
  const cleanedBody = body
    .split("\n")
    .filter((line) => !line.match(/^\s*<!--.*-->\s*$/))
    .join("\n")
    .trim();

  return { title, body: cleanedBody };
}

Deno.test("parseBugContent returns null for empty content", () => {
  const result = parseBugContent("");
  assertEquals(result, null);
});

Deno.test("parseBugContent returns null for unchanged template", () => {
  const result = parseBugContent(BUG_TEMPLATE);
  assertEquals(result, null);
});

Deno.test("parseBugContent extracts title and body", () => {
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

  const result = parseBugContent(content);
  assertEquals(result?.title, "CLI crashes when running without arguments");
  assertEquals(result?.body.includes("When I run swamp"), true);
  assertEquals(result?.body.startsWith("## Description"), true);
});

Deno.test("parseBugContent returns null when no title provided", () => {
  const content = `
# Bug Report

## Title
<!-- Enter a brief, descriptive title for the bug on the line below -->


## Description
Some description here
`.trimStart();

  const result = parseBugContent(content);
  assertEquals(result, null);
});

Deno.test("parseBugContent handles title with only whitespace after", () => {
  const content = `
# Bug Report

## Title
My bug title

## Description
Bug description
`.trimStart();

  const result = parseBugContent(content);
  assertEquals(result?.title, "My bug title");
  assertEquals(result?.body.includes("Bug description"), true);
});
