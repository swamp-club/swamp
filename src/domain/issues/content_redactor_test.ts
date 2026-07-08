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
import {
  formatRedactionSummary,
  redactIssueContent,
} from "./content_redactor.ts";

Deno.test("redactIssueContent: returns text unchanged when nothing sensitive", () => {
  const input = "The model failed to run because the schema was invalid.";
  const result = redactIssueContent(input);
  assertEquals(result.text, input);
  assertEquals(result.summary.totalRedactions, 0);
});

Deno.test("redactIssueContent: redacts email addresses", () => {
  const result = redactIssueContent(
    "Contact jane.doe@acme-corp.com for details",
  );
  assertEquals(result.text, "Contact [REDACTED-EMAIL] for details");
  assertEquals(result.summary.categories.get("email"), 1);
});

Deno.test("redactIssueContent: redacts AWS access key IDs", () => {
  const result = redactIssueContent(
    "The key AKIAIOSFODNN7EXAMPLE was exposed",
  );
  assertEquals(result.text, "The key [REDACTED-SECRET] was exposed");
  assertEquals(result.summary.categories.get("secret"), 1);
});

Deno.test("redactIssueContent: redacts GitHub tokens", () => {
  const result = redactIssueContent(
    "Token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn was in the log",
  );
  assertEquals(
    result.text,
    "Token [REDACTED-SECRET] was in the log",
  );
});

Deno.test("redactIssueContent: redacts Bearer tokens", () => {
  const result = redactIssueContent(
    "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.test",
  );
  assertStringIncludes(result.text, "Bearer [REDACTED-SECRET]");
});

Deno.test("redactIssueContent: redacts prefixed API keys", () => {
  const result = redactIssueContent(
    "API key sk_test_00000000000000000000",
  );
  assertEquals(result.text, "API key [REDACTED-SECRET]");
});

Deno.test("redactIssueContent: redacts env-var style secrets", () => {
  const result = redactIssueContent(
    "DATABASE_PASSWORD=hunter2 was in .env",
  );
  assertEquals(result.text, "DATABASE_PASSWORD=[REDACTED-SECRET] was in .env");
});

Deno.test("redactIssueContent: redacts SSN patterns", () => {
  const result = redactIssueContent("SSN was 123-45-6789 in the form");
  assertEquals(result.text, "SSN was [REDACTED-ID] in the form");
});

Deno.test("redactIssueContent: redacts credit cards with Luhn validation", () => {
  // 4111111111111111 is a valid Luhn test number
  const result = redactIssueContent(
    "Card number 4111111111111111 was logged",
  );
  assertEquals(result.text, "Card number [REDACTED-CC] was logged");
});

Deno.test("redactIssueContent: leaves invalid credit card numbers alone", () => {
  const result = redactIssueContent("ID 1234567890123456 in database");
  // Not a valid Luhn number, so should not be redacted as CC
  // (may or may not be redacted by other patterns)
  const text = result.text;
  assertEquals(text.includes("[REDACTED-CC]"), false);
});

Deno.test("redactIssueContent: redacts phone numbers", () => {
  const result = redactIssueContent("Call +1 555-867-5309 for support");
  assertStringIncludes(result.text, "[REDACTED-PHONE]");
});

Deno.test("redactIssueContent: redacts connection string credentials", () => {
  const result = redactIssueContent(
    "postgres://admin:s3cret@db-prod.internal:5432/mydb",
  );
  assertStringIncludes(result.text, "postgres://[REDACTED-USER]:***@");
  assertStringIncludes(result.text, ":5432/mydb");
  assertEquals(result.text.includes("s3cret"), false);
  assertEquals(result.text.includes("admin"), false);
});

Deno.test("redactIssueContent: redacts home directory usernames on macOS", () => {
  const result = redactIssueContent(
    "Error at /Users/janedoe/code/swamp/src/main.ts",
  );
  assertEquals(
    result.text,
    "Error at /Users/[REDACTED]/code/swamp/src/main.ts",
  );
});

Deno.test("redactIssueContent: redacts home directory usernames on Linux", () => {
  const result = redactIssueContent(
    "Config in /home/jdoe/.config/swamp/config.yaml",
  );
  assertEquals(
    result.text,
    "Config in /home/[REDACTED]/.config/swamp/config.yaml",
  );
});

Deno.test("redactIssueContent: redacts home directory usernames on Windows", () => {
  const result = redactIssueContent(
    "Path C:\\Users\\JaneDoe\\AppData\\Local\\swamp",
  );
  assertEquals(
    result.text,
    "Path C:\\Users\\[REDACTED]\\AppData\\Local\\swamp",
  );
});

Deno.test("redactIssueContent: replaces IPv4 with stable placeholders", () => {
  const result = redactIssueContent(
    "Server at 10.0.3.47 could not reach 10.0.3.48, tried 10.0.3.47 again",
  );
  assertStringIncludes(result.text, "[IP-1]");
  assertStringIncludes(result.text, "[IP-2]");
  // Same IP gets the same placeholder
  const first = result.text.indexOf("[IP-1]");
  const second = result.text.lastIndexOf("[IP-1]");
  assertEquals(first !== second, true);
  assertEquals(result.text.includes("10.0.3.47"), false);
  assertEquals(result.text.includes("10.0.3.48"), false);
});

Deno.test("redactIssueContent: replaces public IPv4 addresses too", () => {
  const result = redactIssueContent("Resolved to 52.14.88.201");
  assertStringIncludes(result.text, "[IP-");
  assertEquals(result.text.includes("52.14.88.201"), false);
});

Deno.test("redactIssueContent: does not treat version numbers as IPs", () => {
  const result = redactIssueContent("Running swamp version 1.23.4");
  assertEquals(result.text, "Running swamp version 1.23.4");
});

Deno.test("redactIssueContent: replaces internal hostnames with stable placeholders", () => {
  const result = redactIssueContent(
    "Could not connect to db-prod.internal then tried cache.internal",
  );
  assertStringIncludes(result.text, "[HOST-1]");
  assertStringIncludes(result.text, "[HOST-2]");
  assertEquals(result.text.includes("db-prod.internal"), false);
});

Deno.test("redactIssueContent: replaces FQDNs with stable placeholders", () => {
  const result = redactIssueContent(
    "DNS lookup for api.acme-corp.prod.net failed",
  );
  assertStringIncludes(result.text, "[HOST-");
  assertEquals(result.text.includes("api.acme-corp.prod.net"), false);
});

Deno.test("redactIssueContent: same hostname gets same placeholder", () => {
  const result = redactIssueContent(
    "Tried db.corp twice: first db.corp then db.corp",
  );
  // All three occurrences should be the same placeholder
  const matches = result.text.match(/\[HOST-1\]/g);
  assertEquals(matches?.length, 3);
});

Deno.test("redactIssueContent: preserves allowlisted public hosts", () => {
  const result = redactIssueContent(
    "Push to github.com failed, checked api.swamp-club.com",
  );
  assertStringIncludes(result.text, "github.com");
  assertStringIncludes(result.text, "api.swamp-club.com");
});

Deno.test("redactIssueContent: preserves subdomains of allowlisted hosts", () => {
  const result = redactIssueContent(
    "Fetching from registry.npmjs.org works",
  );
  assertStringIncludes(result.text, "registry.npmjs.org");
});

Deno.test("redactIssueContent: preserves error messages and stack traces", () => {
  const input = `Error: ECONNREFUSED
    at TCPConnectWrap.afterConnect [as oncomplete]
    at Module._compile (node:internal/modules/cjs/loader:1234:14)
  Code: ECONNREFUSED`;
  const result = redactIssueContent(input);
  assertStringIncludes(result.text, "ECONNREFUSED");
  assertStringIncludes(result.text, "TCPConnectWrap");
});

Deno.test("redactIssueContent: preserves swamp diagnostic info", () => {
  const input = `swamp version: 1.2.3
OS: darwin (arm64)
Deno: 2.1.0
Shell: /bin/zsh
Model: @adam/cfgmgmt
Method: run`;
  const result = redactIssueContent(input);
  assertStringIncludes(result.text, "1.2.3");
  assertStringIncludes(result.text, "darwin");
  assertStringIncludes(result.text, "2.1.0");
  assertStringIncludes(result.text, "@adam/cfgmgmt");
});

Deno.test("redactIssueContent: handles multiple categories in one text", () => {
  const result = redactIssueContent(
    "User admin@corp.com hit error on 10.0.1.5 with API_TOKEN=abc123xyz",
  );
  assertEquals(result.text.includes("admin@corp.com"), false);
  assertEquals(result.text.includes("10.0.1.5"), false);
  assertEquals(result.text.includes("abc123xyz"), false);
  assertEquals(result.summary.totalRedactions >= 3, true);
});

Deno.test("redactIssueContent: long hex strings are redacted", () => {
  const hex = "a".repeat(40);
  const result = redactIssueContent(`Token was ${hex} in header`);
  assertEquals(result.text, "Token was [REDACTED-SECRET] in header");
});

Deno.test("redactIssueContent: IPv6 addresses are redacted", () => {
  const result = redactIssueContent(
    "Listening on 2001:0db8:85a3:0000:0000:8a2e:0370:7334",
  );
  assertStringIncludes(result.text, "[IP-");
  assertEquals(
    result.text.includes("2001:0db8:85a3:0000:0000:8a2e:0370:7334"),
    false,
  );
});

Deno.test("formatRedactionSummary: returns empty string for zero redactions", () => {
  assertEquals(
    formatRedactionSummary({ totalRedactions: 0, categories: new Map() }),
    "",
  );
});

Deno.test("formatRedactionSummary: formats single category", () => {
  const summary = {
    totalRedactions: 2,
    categories: new Map([["email", 2]]),
  };
  assertEquals(
    formatRedactionSummary(summary),
    "Redacted 2 email from issue content.",
  );
});

Deno.test("formatRedactionSummary: formats multiple categories", () => {
  const summary = {
    totalRedactions: 5,
    categories: new Map([["secret", 3], ["IP", 2]]),
  };
  const msg = formatRedactionSummary(summary);
  assertStringIncludes(msg, "3 secret");
  assertStringIncludes(msg, "2 IP");
});
