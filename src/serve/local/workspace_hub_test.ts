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
import { withMockedEnv } from "../../infrastructure/persistence/path_test_helpers.ts";
import { HUB_TOKEN_ENV } from "./hub_token.ts";
import { actionEnv, childEnv } from "./workspace_hub.ts";

Deno.test("actionEnv: keeps the hub's environment but never the serve URLs", () => {
  withMockedEnv({
    SWAMP_SERVE_URL: "ws://serve.example:9090",
    SWAMP_SERVER_URL: "ws://serve.example:9090",
    SWAMP_TEST_KEEP: "kept",
  }, () => {
    const env = actionEnv();
    assertEquals(env.SWAMP_SERVE_URL, undefined);
    assertEquals(env.SWAMP_SERVER_URL, undefined);
    assertEquals(env.SWAMP_TEST_KEEP, "kept");
  });
});

Deno.test("childEnv: a workspace child never starts as a thin client, and gets its token", () => {
  withMockedEnv({
    SWAMP_SERVE_URL: "ws://serve.example:9090",
    SWAMP_SERVER_URL: "ws://serve.example:9090",
    SWAMP_TEST_KEEP: "kept",
  }, () => {
    const env = childEnv("child-token");
    assertEquals(env.SWAMP_SERVE_URL, undefined);
    assertEquals(env.SWAMP_SERVER_URL, undefined);
    assertEquals(env.SWAMP_TEST_KEEP, "kept");
    assertEquals(env[HUB_TOKEN_ENV], "child-token");
  });
});
