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
  formatRedactionDetails,
  formatRedactionSummary,
  redactIssueContent,
  redactIssueTitleAndBody,
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
  assertEquals(result.text, "The key [REDACTED-SECRET-1] was exposed");
  assertEquals(result.summary.categories.get("secret"), 1);
});

Deno.test("redactIssueContent: redacts GitHub tokens", () => {
  const result = redactIssueContent(
    "Token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn was in the log",
  );
  assertEquals(
    result.text,
    "Token [REDACTED-SECRET-1] was in the log",
  );
});

Deno.test("redactIssueContent: redacts Bearer tokens", () => {
  const result = redactIssueContent(
    "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.test",
  );
  assertStringIncludes(result.text, "Bearer [REDACTED-SECRET-1]");
});

Deno.test("redactIssueContent: redacts padded Bearer tokens", () => {
  const result = redactIssueContent(
    "Bearer dG9rZW5WYWx1ZTEyMzQ1Njc4OTAxMjM0NTY3ODkw== next",
  );
  assertEquals(result.text, "Bearer [REDACTED-SECRET-1] next");
});

Deno.test("redactIssueContent: Bearer at end of line leaves the next line alone", () => {
  const result = redactIssueContent(
    "The header was Bearer\nRestart the daemon",
  );
  assertEquals(result.text, "The header was Bearer\nRestart the daemon");
});

Deno.test("redactIssueContent: redacts prefixed API keys", () => {
  const result = redactIssueContent(
    "API key sk_test_00000000000000000000",
  );
  assertEquals(result.text, "API key [REDACTED-SECRET-1]");
});

Deno.test("redactIssueContent: redacts env-var style secrets", () => {
  const result = redactIssueContent(
    "DATABASE_PASSWORD=hunter2 was in .env",
  );
  assertEquals(
    result.text,
    "DATABASE_PASSWORD=[REDACTED-SECRET-1] was in .env",
  );
});

Deno.test("redactIssueContent: env-var values keep their closing quote", () => {
  const result = redactIssueContent(
    'run: echo "MY_TOKEN=hunter2" in the shell',
  );
  assertEquals(
    result.text,
    'run: echo "MY_TOKEN=[REDACTED-SECRET-1]" in the shell',
  );
});

Deno.test("redactIssueContent: quote-initial env-var values are redacted inside their delimiters", () => {
  const result = redactIssueContent('MY_TOKEN="real secret value"');
  assertEquals(result.text, 'MY_TOKEN="[REDACTED-SECRET-1]"');
});

Deno.test("redactIssueContent: masked env-var values pass through untouched", () => {
  const result = redactIssueContent("| case A | MY_TOKEN=*** |");
  assertEquals(result.text, "| case A | MY_TOKEN=*** |");
  assertEquals(result.summary.totalRedactions, 0);
});

Deno.test("redactIssueContent: variable-reference env-var values pass through untouched", () => {
  const input = 'run: echo "MY_TOKEN=${FROM_VAULT}"';
  const result = redactIssueContent(input);
  assertEquals(result.text, input);
  assertEquals(result.summary.totalRedactions, 0);
});

Deno.test("redactIssueContent: masked-vs-unmasked evidence table keeps its contrast", () => {
  const input = [
    "| case A | MY_TOKEN=*** |",
    "| case B | MY_TOKEN=the-actual-value |",
  ].join("\n");
  const result = redactIssueContent(input);
  const [rowA, rowB] = result.text.split("\n");
  assertEquals(rowA, "| case A | MY_TOKEN=*** |");
  assertEquals(rowB, "| case B | MY_TOKEN=[REDACTED-SECRET-1] |");
});

Deno.test("redactIssueContent: distinct env-var values get distinct placeholders, same value the same one", () => {
  const result = redactIssueContent(
    "MY_TOKEN=first-value OTHER_SECRET=second-value AGAIN_TOKEN=first-value",
  );
  assertEquals(
    result.text,
    "MY_TOKEN=[REDACTED-SECRET-1] OTHER_SECRET=[REDACTED-SECRET-2] AGAIN_TOKEN=[REDACTED-SECRET-1]",
  );
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
  const text = result.text;
  assertEquals(text.includes("[REDACTED-CC]"), false);
});

Deno.test("redactIssueContent: redacts phone numbers with separators", () => {
  const result = redactIssueContent("Call +1 555-867-5309 for support");
  assertStringIncludes(result.text, "[REDACTED-PHONE]");
});

Deno.test("redactIssueContent: does not match bare digit runs as phone numbers", () => {
  const result = redactIssueContent("batch 20260708 at offset 12345678");
  assertEquals(result.text.includes("[REDACTED-PHONE]"), false);
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

Deno.test("redactIssueContent: handles /home/home without leaking username", () => {
  const result = redactIssueContent("Path /home/home/.config/swamp");
  assertEquals(result.text, "Path /home/[REDACTED]/.config/swamp");
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
  assertEquals(result.text, "Token was [REDACTED-SECRET-1] in header");
});

Deno.test("redactIssueContent: scheme URL without credentials does not swallow following lines", () => {
  const input = [
    "Steps:",
    "1. Point the client at ws://gateway:9000/socket",
    "2. Observe the reconnect loop",
    "3. Expected: single connection",
    "",
    "Uses the @swamp/issue-lifecycle package.",
  ].join("\n");
  const result = redactIssueContent(input);
  assertEquals(result.text, input);
  assertEquals(result.summary.totalRedactions, 0);
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

// --- redactIssueTitleAndBody ---

Deno.test("redactIssueTitleAndBody: shares placeholders across title and body", () => {
  const result = redactIssueTitleAndBody(
    "Error on 10.0.3.47",
    "The server 10.0.3.47 returned 500, also tried 10.0.3.48",
  );
  // Same IP in title and body should get the same placeholder
  assertStringIncludes(result.title.text, "[IP-1]");
  assertStringIncludes(result.body.text, "[IP-1]");
  assertStringIncludes(result.body.text, "[IP-2]");
  assertEquals(result.title.text.includes("10.0.3.47"), false);
  assertEquals(result.body.text.includes("10.0.3.47"), false);
});

Deno.test("redactIssueTitleAndBody: returns combined summary", () => {
  const result = redactIssueTitleAndBody(
    "Bug on 10.0.1.1",
    "Contact admin@example.org for 10.0.1.2",
  );
  assertEquals(result.summary.totalRedactions >= 3, true);
  assertEquals(
    (result.summary.categories.get("IP address") ?? 0) >= 2,
    true,
  );
});

// --- line-level changes ---

Deno.test("redactIssueContent: reports per-line changes with line numbers", () => {
  const input = [
    "First line is fine",
    "DATABASE_PASSWORD=hunter2 leaked here",
    "Third line is fine",
    "Contact admin@corp.com about it",
  ].join("\n");
  const result = redactIssueContent(input);
  assertEquals(result.changes.length, 2);
  assertEquals(result.changes[0].lineNumber, 2);
  assertEquals(
    result.changes[0].original,
    "DATABASE_PASSWORD=hunter2 leaked here",
  );
  assertEquals(
    result.changes[0].redacted,
    "DATABASE_PASSWORD=[REDACTED-SECRET-1] leaked here",
  );
  assertEquals(result.changes[1].lineNumber, 4);
});

Deno.test("redactIssueContent: reports no changes when nothing was redacted", () => {
  const result = redactIssueContent("Nothing sensitive here");
  assertEquals(result.changes.length, 0);
});

Deno.test("redactIssueTitleAndBody: reports changes per field", () => {
  const result = redactIssueTitleAndBody(
    "Error contacting 10.0.3.47",
    "All good in the body",
  );
  assertEquals(result.title.changes.length, 1);
  assertEquals(result.title.changes[0].lineNumber, 1);
  assertEquals(result.body.changes.length, 0);
});

// --- formatRedactionDetails ---

Deno.test("formatRedactionDetails: formats line number and before/after", () => {
  const lines = formatRedactionDetails([
    { lineNumber: 3, original: "TOKEN=abc", redacted: "TOKEN=[X-1]" },
  ]);
  assertEquals(lines, ["line 3: TOKEN=abc -> TOKEN=[X-1]"]);
});

Deno.test("formatRedactionDetails: prefixes the label when given", () => {
  const lines = formatRedactionDetails(
    [{ lineNumber: 1, original: "a", redacted: "b" }],
    "title",
  );
  assertEquals(lines, ["title line 1: a -> b"]);
});

Deno.test("formatRedactionDetails: escapes newlines and truncates long content", () => {
  const long = "x".repeat(500);
  const lines = formatRedactionDetails([
    { lineNumber: 2, original: `one\ntwo\n${long}`, redacted: "gone" },
  ]);
  assertStringIncludes(lines[0], "one\\ntwo\\n");
  assertEquals(lines[0].includes("\n"), false);
  assertStringIncludes(lines[0], "…");
  assertStringIncludes(lines[0], "-> gone");
});

// --- formatRedactionSummary ---

Deno.test("formatRedactionSummary: returns empty string for zero redactions", () => {
  assertEquals(
    formatRedactionSummary({ totalRedactions: 0, categories: new Map() }),
    "",
  );
});

Deno.test("formatRedactionSummary: uses human-readable names with pluralization", () => {
  const summary = {
    totalRedactions: 5,
    categories: new Map([["secret", 3], ["IP address", 2]]),
  };
  const msg = formatRedactionSummary(summary);
  assertStringIncludes(msg, "3 secrets");
  assertStringIncludes(msg, "2 IP addresses");
});

Deno.test("formatRedactionSummary: singular form for count of 1", () => {
  const summary = {
    totalRedactions: 1,
    categories: new Map([["email", 1]]),
  };
  const msg = formatRedactionSummary(summary);
  assertStringIncludes(msg, "1 email");
  assertEquals(msg.includes("emails"), false);
});
