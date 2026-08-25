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

Deno.test("redactErrorMessage: redacts macOS home directory path", () => {
  const result = redactErrorMessage(
    "Not a swamp repository: /Users/johndoe/projects/myapp. Run 'swamp repo init'.",
  );
  assertEquals(
    result,
    "Not a swamp repository: /Users/<REDACTED>/projects/myapp. Run 'swamp repo init'.",
  );
});

Deno.test("redactErrorMessage: redacts Linux home directory path", () => {
  const result = redactErrorMessage(
    "File not found: /home/alice/workspace/models/test.yaml",
  );
  assertEquals(
    result,
    "File not found: /home/<REDACTED>/workspace/models/test.yaml",
  );
});

Deno.test("redactErrorMessage: redacts Windows backslash path", () => {
  const result = redactErrorMessage(
    "Cannot read file: C:\\Users\\bob\\Documents\\swamp\\model.yaml",
  );
  assertEquals(
    result,
    "Cannot read file: C:\\Users\\<REDACTED>\\Documents\\swamp\\model.yaml",
  );
});

Deno.test("redactErrorMessage: redacts Windows forward-slash path", () => {
  const result = redactErrorMessage(
    "Cannot read file: C:/Users/bob/Documents/swamp/model.yaml",
  );
  assertEquals(
    result,
    "Cannot read file: C:/Users/<REDACTED>/Documents/swamp/model.yaml",
  );
});

Deno.test("redactErrorMessage: redacts multiple home paths in one message", () => {
  const result = redactErrorMessage(
    "Cannot copy /Users/alice/src to /Users/alice/dest",
  );
  assertEquals(
    result,
    "Cannot copy /Users/<REDACTED>/src to /Users/<REDACTED>/dest",
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
    "Failed syncing /home/<REDACTED>/repo to <REDACTED-HOST>",
  );
});
