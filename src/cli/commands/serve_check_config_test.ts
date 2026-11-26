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
import { join } from "@std/path";
import { Command } from "@cliffy/command";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { withMockedEnv } from "../../infrastructure/persistence/path_test_helpers.ts";
import { FEDERATION_GATE_VARIABLE } from "../../domain/serve/federation_gate.ts";

import "../../domain/models/models.ts";

await initializeLogging({});

async function checkConfigJson(
  serveYaml: string,
  gate: string | undefined,
): Promise<Record<string, unknown>> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-check-config-" });
  try {
    await Deno.mkdir(join(dir, ".swamp"), { recursive: true });
    await Deno.writeTextFile(join(dir, ".swamp", "serve.yaml"), serveYaml);
    const { checkConfigCommand } = await import("./serve_check_config.ts");
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    try {
      await withMockedEnv(
        { [FEDERATION_GATE_VARIABLE]: gate },
        () =>
          new Command()
            .throwErrors()
            .globalOption("--json", "JSON output")
            .command("check-config", checkConfigCommand)
            .parse(["check-config", "--json", "--repo-dir", dir]),
      );
    } finally {
      console.log = originalLog;
      Deno.exitCode = 0;
    }
    return JSON.parse(logs[logs.length - 1]);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("checkConfigCommand: with the gate off, JSON carries no config version", async () => {
  const data = await checkConfigJson("port: 9090\n", undefined);
  assertEquals("configVersion" in data, false);
});

Deno.test("checkConfigCommand: with the gate on, JSON reports the config version", async () => {
  assertEquals(
    (await checkConfigJson("port: 9090\n", "1")).configVersion,
    1,
  );
  assertEquals(
    (await checkConfigJson("version: 2\nport: 9090\n", "1")).configVersion,
    2,
  );
});
