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
 * Template for feature requests (copied from issue_feature.ts for testing).
 */
const FEATURE_TEMPLATE = `
# Feature Request

## Title
<!-- Enter a brief, descriptive title for the feature on the line below -->


## Problem Statement
<!-- What problem does this feature solve? What pain point are you experiencing? -->


## Proposed Solution
<!-- Describe the solution you'd like to see -->


## Alternatives Considered
<!-- Have you considered any alternative solutions or workarounds? -->


## Additional Context
<!-- Add any other context, mockups, or examples about the feature request here -->

`.trimStart();

/**
 * Parses the feature request content from the editor.
 * Returns null if the content is empty or unchanged from the template.
 */
function parseFeatureContent(
  content: string,
): { title: string; body: string } | null {
  // Check if content is essentially empty or unchanged
  const trimmedContent = content.trim();
  if (!trimmedContent || trimmedContent === FEATURE_TEMPLATE.trim()) {
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

  // Build body from remaining sections (everything after ## Problem Statement)
  const problemIndex = content.indexOf("## Problem Statement");
  if (problemIndex === -1) {
    return { title, body: "" };
  }

  const body = content.substring(problemIndex);

  // Clean up the body by removing HTML comment lines
  const cleanedBody = body
    .split("\n")
    .filter((line) => !line.match(/^\s*<!--.*-->\s*$/))
    .join("\n")
    .trim();

  return { title, body: cleanedBody };
}

Deno.test("parseFeatureContent returns null for empty content", () => {
  const result = parseFeatureContent("");
  assertEquals(result, null);
});

Deno.test("parseFeatureContent returns null for unchanged template", () => {
  const result = parseFeatureContent(FEATURE_TEMPLATE);
  assertEquals(result, null);
});

Deno.test("parseFeatureContent extracts title and body", () => {
  const content = `
# Feature Request

## Title
<!-- Enter a brief, descriptive title for the feature on the line below -->
Add dark mode support

## Problem Statement
<!-- What problem does this feature solve? What pain point are you experiencing? -->
The current light theme is hard on the eyes at night.

## Proposed Solution
<!-- Describe the solution you'd like to see -->
Add a --dark-mode flag or automatic detection.

## Alternatives Considered
<!-- Have you considered any alternative solutions or workarounds? -->
Using terminal dark mode, but it doesn't affect output colors.

## Additional Context
<!-- Add any other context, mockups, or examples about the feature request here -->
None
`.trimStart();

  const result = parseFeatureContent(content);
  assertEquals(result?.title, "Add dark mode support");
  assertEquals(result?.body.includes("hard on the eyes"), true);
  assertEquals(result?.body.startsWith("## Problem Statement"), true);
});

Deno.test("parseFeatureContent returns null when no title provided", () => {
  const content = `
# Feature Request

## Title
<!-- Enter a brief, descriptive title for the feature on the line below -->


## Problem Statement
Some problem here
`.trimStart();

  const result = parseFeatureContent(content);
  assertEquals(result, null);
});

Deno.test("parseFeatureContent handles title with only whitespace after", () => {
  const content = `
# Feature Request

## Title
My feature title

## Problem Statement
Problem description
`.trimStart();

  const result = parseFeatureContent(content);
  assertEquals(result?.title, "My feature title");
  assertEquals(result?.body.includes("Problem description"), true);
});
