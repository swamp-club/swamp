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
import { authGateTiming } from "./auth_gate_exemptions.ts";
import { extractCommandInfo } from "./telemetry_integration.ts";

function timing(args: string[]) {
  return authGateTiming(extractCommandInfo(args), args);
}

Deno.test("authGateTiming: bare swamp and the auth path are exempt", () => {
  for (
    const args of [
      [],
      ["--json"],
      ["--help"],
      ["-h"],
      ["--version"],
      ["-V"],
      ["auth"],
      ["auth", "login"],
      ["auth", "logout", "--json"],
      ["auth", "whoami"],
      ["--json", "auth", "whoami"],
    ]
  ) {
    assertEquals(timing(args), "exempt", args.join(" "));
  }
});

Deno.test("authGateTiming: every other subcommand is gated at startup", () => {
  for (
    const args of [
      ["version"],
      ["help", "model"],
      ["update"],
      ["completions", "zsh"],
      ["telemetry", "disable"],
      ["config", "show"],
      ["serve"],
      ["worker", "exec-dispatch"],
      ["audit", "record", "--from-hook"],
      ["auth", "server-login"],
      ["auth", "token", "list"],
      ["model", "method", "run", "m", "go"],
      ["modle"],
    ]
  ) {
    assertEquals(timing(args), "startup", args.join(" "));
  }
});

Deno.test("authGateTiming: help and version flags defer the gate to Cliffy's global action", () => {
  for (
    const args of [
      ["model", "--help"],
      ["model", "method", "run", "-h"],
      ["--json", "serve", "--help"],
      ["model", "method", "run", "m", "go", "--input", "--help"],
    ]
  ) {
    assertEquals(timing(args), "deferred", args.join(" "));
  }
});

Deno.test("authGateTiming: a help token after -- is a literal argument", () => {
  assertEquals(
    timing(["model", "method", "run", "m", "go", "--", "--help"]),
    "startup",
  );
});

Deno.test("authGateTiming: a value that merely contains --help is not a flag", () => {
  assertEquals(
    timing(["model", "method", "run", "m", "go", "--input=--help"]),
    "startup",
  );
});
