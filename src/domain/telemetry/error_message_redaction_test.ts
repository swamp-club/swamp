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
import { redactErrorMessage } from "./error_message_redaction.ts";

Deno.test("redactErrorMessage: redacts macOS home directory path whole", () => {
  const result = redactErrorMessage(
    "Not a swamp repository: /Users/johndoe/projects/myapp. Run 'swamp repo init'.",
  );
  assertEquals(
    result,
    "Not a swamp repository: <PATH>. Run 'swamp repo init'.",
  );
});

Deno.test("redactErrorMessage: redacts Linux home directory path whole", () => {
  const result = redactErrorMessage(
    "File not found: /home/alice/workspace/models/test.yaml",
  );
  assertEquals(
    result,
    "File not found: <PATH>",
  );
});

Deno.test("redactErrorMessage: redacts Windows backslash path", () => {
  const result = redactErrorMessage(
    "Cannot read file: C:\\Users\\bob\\Documents\\swamp\\model.yaml",
  );
  assertEquals(
    result,
    "Cannot read file: <PATH>",
  );
});

Deno.test("redactErrorMessage: redacts Windows forward-slash path", () => {
  const result = redactErrorMessage(
    "Cannot read file: C:/Users/bob/Documents/swamp/model.yaml",
  );
  assertEquals(
    result,
    "Cannot read file: <PATH>",
  );
});

Deno.test("redactErrorMessage: redacts multiple paths in one message", () => {
  const result = redactErrorMessage(
    "Cannot copy /Users/alice/src to /Users/alice/dest",
  );
  assertEquals(
    result,
    "Cannot copy <PATH> to <PATH>",
  );
});

Deno.test("redactErrorMessage: redacts internal hostnames", () => {
  const result = redactErrorMessage(
    "Connection refused: db-primary.internal:5432",
  );
  assertEquals(result, "Connection refused: <REDACTED-HOST>:5432");
});

Deno.test("redactErrorMessage: redacts .local hostnames", () => {
  const result = redactErrorMessage(
    "Cannot reach build-server.local",
  );
  assertEquals(result, "Cannot reach <REDACTED-HOST>");
});

Deno.test("redactErrorMessage: redacts .corp hostnames", () => {
  const result = redactErrorMessage(
    "Timeout connecting to api.corp",
  );
  assertEquals(result, "Timeout connecting to <REDACTED-HOST>");
});

Deno.test("redactErrorMessage: passes through safe error messages", () => {
  const message = "Model not found: my-model";
  assertEquals(redactErrorMessage(message), message);
});

Deno.test("redactErrorMessage: passes through error codes and types", () => {
  const message = "UserError: Invalid CEL expression in query";
  assertEquals(redactErrorMessage(message), message);
});

Deno.test("redactErrorMessage: passes through swamp-club.com domain", () => {
  const message = "Authentication failed: https://swamp-club.com/api/v1/auth";
  assertEquals(redactErrorMessage(message), message);
});

Deno.test("redactErrorMessage: passes through empty string", () => {
  assertEquals(redactErrorMessage(""), "");
});

Deno.test("redactErrorMessage: handles combined path and hostname", () => {
  const result = redactErrorMessage(
    "Failed syncing /home/deploy/repo to cache.internal",
  );
  assertEquals(
    result,
    "Failed syncing <PATH> to <REDACTED-HOST>",
  );
});

Deno.test("redactErrorMessage: redacts non-home absolute paths", () => {
  assertEquals(
    redactErrorMessage("Not a swamp repository: /opt/automation/acme-billing"),
    "Not a swamp repository: <PATH>",
  );
});

Deno.test("redactErrorMessage: redacts home-relative and UNC paths", () => {
  assertEquals(
    redactErrorMessage(
      "Cannot open ~/acme/secret.yaml or \\\\fileserver\\acme",
    ),
    "Cannot open <PATH> or <PATH>",
  );
});

Deno.test("redactErrorMessage: redacts quoted paths and keeps the quotes", () => {
  assertEquals(
    redactErrorMessage("Directory '/srv/acme' is not empty; \"/tmp/x\" too"),
    "Directory '<PATH>' is not empty; \"<PATH>\" too",
  );
});

Deno.test("redactErrorMessage: keeps sentence punctuation and line suffixes", () => {
  assertEquals(
    redactErrorMessage("Parse error at /srv/acme/model.yaml:12:4."),
    "Parse error at <PATH>:12:4.",
  );
});

Deno.test("redactErrorMessage: keeps names, type names and relative paths", () => {
  const message =
    "Model not found: acme-prod (type command/shell, @swamp/aws/ec2, see ./models/x.yaml)";
  assertEquals(redactErrorMessage(message), message);
});

Deno.test("redactErrorMessage: keeps network URLs", () => {
  const message = "Fetch failed: https://example.com/a/b and http://h:8080/c";
  assertEquals(redactErrorMessage(message), message);
});

Deno.test("redactErrorMessage: redacts file URLs, quoted or not", () => {
  assertEquals(
    redactErrorMessage(
      'Module not found "file:///home/alice/acme corp/models/x.ts".',
    ),
    'Module not found "<PATH>".',
  );
  assertEquals(
    redactErrorMessage("error loading file:///Users/jane/acme/x.ts:12:3"),
    "error loading <PATH>:12:3",
  );
});

Deno.test("redactErrorMessage: redacts a path glued to a colon", () => {
  assertEquals(
    redactErrorMessage("failed at path:/srv/acme-billing"),
    "failed at path:<PATH>",
  );
});

Deno.test("redactErrorMessage: a long run of :N segments redacts without backtracking", () => {
  // A backtracking suffix grammar made this exponential in the run length;
  // at this size an ambiguous pattern would never finish.
  const message = "Failed: /a" + ":1".repeat(5000) + "x";
  assertEquals(redactErrorMessage(message), "Failed: <PATH>");
});

Deno.test("redactErrorMessage: redacts a quoted path containing spaces whole", () => {
  assertEquals(
    redactErrorMessage(
      "Cannot read 'C:\\Users\\John Smith\\Acme Corp\\a.yaml' or \"/Users/jane/Application Support/acme\"",
    ),
    "Cannot read '<PATH>' or \"<PATH>\"",
  );
});

Deno.test("redactErrorMessage: an unquoted path ends at the first space", () => {
  // Documented limitation: without quotes there is no reliable end to a path.
  assertEquals(
    redactErrorMessage("Cannot read /Users/jane/Application Support/x"),
    "Cannot read <PATH> Support/x",
  );
});
