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
import { parseSecurityContent } from "./issue_security.ts";

Deno.test("parseSecurityContent: extracts title and body", () => {
  const content = `# Security Report

## Title
XSS in profile page

## Description
Unsanitized user input in profile fields.

## Steps to Reproduce
1. Set name to <script>alert(1)</script>
`;
  const result = parseSecurityContent(content);
  assertEquals(result?.title, "XSS in profile page");
  assertEquals(result?.body.includes("Unsanitized user input"), true);
});

Deno.test("parseSecurityContent: returns null for empty content", () => {
  assertEquals(parseSecurityContent(""), null);
  assertEquals(parseSecurityContent("   "), null);
});

Deno.test("parseSecurityContent: returns null for unchanged template", () => {
  const template = `# Security Report

## Title
<!-- Enter a brief, descriptive title for the vulnerability on the line below -->


## Description
<!-- Describe the security issue. What is the vulnerability? What is the potential impact? -->


## Steps to Reproduce
<!-- List the steps to reproduce the vulnerability -->
1.
2.
3.

## Affected Components
<!-- Which parts of swamp are affected? (CLI, runtime, API, extensions, etc.) -->


## Severity Assessment
<!-- Your assessment: low, medium, high, or critical -->


## Additional Context
<!-- Add any other context about the security issue here -->
`;
  assertEquals(parseSecurityContent(template), null);
});

Deno.test("parseSecurityContent: returns null when title is missing", () => {
  const content = `# Security Report

## Title

## Description
Some description.
`;
  assertEquals(parseSecurityContent(content), null);
});

Deno.test("parseSecurityContent: strips HTML comments from body", () => {
  const content = `# Security Report

## Title
Vuln found

## Description
<!-- Describe the security issue. What is the vulnerability? What is the potential impact? -->
Real description here.
`;
  const result = parseSecurityContent(content);
  assertEquals(result?.body.includes("<!--"), false);
  assertEquals(result?.body.includes("Real description here"), true);
});
