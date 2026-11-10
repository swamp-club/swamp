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
  CHILD_SWITCHES,
  childEnv,
  preflightRefusal,
  UNKNOWN_COMMAND_EXIT,
} from "./swamp_child_env.ts";

Deno.test("childEnv: adds the three switches and the private TMPDIR", () => {
  const env = childEnv({ PATH: "/bin", TMPDIR: "/tmp" }, "/scratch/tmp");
  assertEquals(env.PATH, "/bin");
  assertEquals(env.TMPDIR, "/scratch/tmp");
  assertEquals(env.SWAMP_NO_TELEMETRY, "1");
  assertEquals(env.SWAMP_NO_UPDATE_CHECK, "1");
  assertEquals(env.SWAMP_NO_INBOX_NOTICE, "1");
  assertEquals(Object.keys(CHILD_SWITCHES).length, 3);
});

Deno.test("childEnv: keeps the config location and credentials the auth gate reads", () => {
  const base = {
    HOME: "/home/dev",
    XDG_CONFIG_HOME: "/home/dev/.config",
    SWAMP_HOME: "/home/dev/.swamp",
    SWAMP_CONFIG_DIR: "/etc/swamp",
    SWAMP_API_KEY: "key",
    SWAMP_API_KEY_FILE: "/run/key",
    SWAMP_SIGNIN_TOKEN: "token",
    SWAMP_CLUB_URL: "https://example.test",
  };
  const env = childEnv(base, "/scratch/tmp");
  for (const [name, value] of Object.entries(base)) {
    assertEquals(env[name], value, name);
  }
});

Deno.test("childEnv: drops option defaults and tracing that would redirect a run", () => {
  const env = childEnv({
    SWAMP_REPO_DIR: "/elsewhere",
    SWAMP_SERVE_URL: "ws://server",
    SWAMP_NO_TELEMETRY: "0",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector",
    TRACEPARENT: "00-abc-def-01",
    TRACESTATE: "k=v",
  }, "/scratch/tmp");
  assertEquals(env.SWAMP_REPO_DIR, undefined);
  assertEquals(env.SWAMP_SERVE_URL, undefined);
  assertEquals(env.OTEL_EXPORTER_OTLP_ENDPOINT, undefined);
  assertEquals(env.TRACEPARENT, undefined);
  assertEquals(env.TRACESTATE, undefined);
  assertEquals(env.SWAMP_NO_TELEMETRY, "1");
});

Deno.test("preflightRefusal: the unknown-command exit means the gate let the run through", () => {
  assertEquals(preflightRefusal("swamp", UNKNOWN_COMMAND_EXIT, ""), undefined);
});

Deno.test("preflightRefusal: any other exit names sign-in and carries the stderr", () => {
  const refusal = preflightRefusal(
    "/bin/swamp",
    1,
    "Error: swamp requires a swamp-club.com account to run.\n",
  );
  assertStringIncludes(refusal ?? "", "/bin/swamp");
  assertStringIncludes(refusal ?? "", "exited 1");
  assertStringIncludes(refusal ?? "", "swamp auth login");
  assertStringIncludes(refusal ?? "", "requires a swamp-club.com account");
});
