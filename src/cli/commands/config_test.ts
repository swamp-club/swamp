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

import { assertStringIncludes } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import "../../domain/models/models.ts";

await initializeLogging({});

Deno.test("config get: rejects unknown key", async () => {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--unstable-bundle",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-run",
      "--allow-sys",
      "main.ts",
      "config",
      "get",
      "unknown.key",
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const result = await cmd.output();
  const stderr = new TextDecoder().decode(result.stderr);
  assertStringIncludes(stderr, "Unknown config key: unknown.key");
  assertStringIncludes(stderr, "update.auto");
});

Deno.test("config set: rejects invalid cadence", async () => {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--unstable-bundle",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-run",
      "--allow-sys",
      "main.ts",
      "config",
      "set",
      "update.cadence",
      "hourly",
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const result = await cmd.output();
  const stderr = new TextDecoder().decode(result.stderr);
  assertStringIncludes(stderr, "Invalid value for update.cadence");
});

Deno.test("config set: rejects unknown key", async () => {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--unstable-bundle",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-run",
      "--allow-sys",
      "main.ts",
      "config",
      "set",
      "bogus.key",
      "value",
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const result = await cmd.output();
  const stderr = new TextDecoder().decode(result.stderr);
  assertStringIncludes(stderr, "Unknown config key: bogus.key");
});
