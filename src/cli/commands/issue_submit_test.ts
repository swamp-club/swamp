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
import { buildMailtoUrl } from "./issue_submit.ts";

Deno.test("buildMailtoUrl: builds correct mailto URL for bug", () => {
  const url = buildMailtoUrl("bug", "CLI crash", "Steps to reproduce");
  assertEquals(url.startsWith("mailto:support@systeminit.com?"), true);
  assertEquals(url.includes("subject=%5Bbug%5D%20CLI%20crash"), true);
  assertEquals(url.includes("body=Steps%20to%20reproduce"), true);
  // Verify no + encoding (RFC 6068 requires %20)
  assertEquals(url.includes("+"), false);
});

Deno.test("buildMailtoUrl: builds correct mailto URL for feature", () => {
  const url = buildMailtoUrl("feature", "Dark mode", "Would be nice");
  assertEquals(url.includes("subject=%5Bfeature%5D%20Dark%20mode"), true);
});

Deno.test("buildMailtoUrl: builds correct mailto URL for security", () => {
  const url = buildMailtoUrl("security", "XSS vuln", "Details");
  assertEquals(url.includes("subject=%5Bsecurity%5D%20XSS%20vuln"), true);
});

Deno.test("buildMailtoUrl: handles special characters", () => {
  const url = buildMailtoUrl("bug", "Test & <stuff>", "Body with &amp;");
  // Should be percent-encoded, not HTML-encoded
  assertEquals(url.includes("&amp;"), false);
  assertEquals(url.includes("%26"), true);
});
