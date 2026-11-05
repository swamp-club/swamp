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
import { ENGINE_PROTOCOL } from "../src/engine/protocol.ts";
import {
  PAGE_HTTP_OPERATIONS,
  PAGE_OPERATIONS,
} from "../src/serve/caller_class.ts";
import {
  DELEGATED_ACTIONS,
  FORWARDED_READS,
  notAvailableLocally,
} from "../src/serve/local/local_actions.ts";
import { MAX_HTTP_REQUEST_BODY_BYTES } from "../src/serve/protocol.ts";
import { COMPRESSION_THRESHOLD_BYTES } from "../src/serve/handlers/shared.ts";
import { MAX_ACTIVE_REQUESTS } from "../src/serve/connection.ts";

const page = ENGINE_PROTOCOL.callerClasses.page;

Deno.test("caller classes: the page set is the dashboard's reads, its four actions and cancel", () => {
  assertEquals(page.operations, [...PAGE_OPERATIONS]);
  assertEquals(page.reads, [...FORWARDED_READS].sort());
  assertEquals(page.actions, [...DELEGATED_ACTIONS]);
  assertEquals(
    [...page.reads, ...page.actions, "cancel"].sort(),
    page.operations,
  );
  assertEquals(page.httpOperations, [...PAGE_HTTP_OPERATIONS]);
});

Deno.test("caller classes: the Go hub refuses a page with the message swamp-uat pins", () => {
  const type = "workflow.run";
  assertEquals(
    page.refusalMessage.replace("${type}", type),
    (notAvailableLocally("x", type) as { error: { message: string } }).error
      .message,
  );
});

Deno.test("caller classes: the Go hub's page limits match the TypeScript servers'", () => {
  assertEquals(
    ENGINE_PROTOCOL.limits.httpRequestBodyBytes,
    MAX_HTTP_REQUEST_BODY_BYTES,
  );
  assertEquals(
    ENGINE_PROTOCOL.limits.compressionThresholdBytes,
    COMPRESSION_THRESHOLD_BYTES,
  );
  assertEquals(
    ENGINE_PROTOCOL.limits.httpRequestsInFlight,
    MAX_ACTIVE_REQUESTS,
  );
});
