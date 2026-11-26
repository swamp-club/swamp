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

import { assertEquals, assertThrows } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

import "../../domain/models/models.ts";

await initializeLogging({});

Deno.test("parseInputFlag: parses key=value", async () => {
  const { parseInputFlag } = await import("./workflow_trigger_set.ts");
  const result = parseInputFlag("channel=#security");
  assertEquals(result, { key: "channel", value: "#security" });
});

Deno.test("parseInputFlag: handles values with equals signs", async () => {
  const { parseInputFlag } = await import("./workflow_trigger_set.ts");
  const result = parseInputFlag("expr=a=b=c");
  assertEquals(result, { key: "expr", value: "a=b=c" });
});

Deno.test("parseInputFlag: throws on missing equals", async () => {
  const { parseInputFlag } = await import("./workflow_trigger_set.ts");
  assertThrows(
    () => parseInputFlag("no-equals"),
    Error,
    "Invalid --input format",
  );
});

Deno.test("parseInputFlag: throws on empty key", async () => {
  const { parseInputFlag } = await import("./workflow_trigger_set.ts");
  assertThrows(
    () => parseInputFlag("=value"),
    Error,
    "Invalid --input format",
  );
});

Deno.test("workflowTriggerSetCommand: has correct name and options", async () => {
  const { workflowTriggerSetCommand } = await import(
    "./workflow_trigger_set.ts"
  );
  assertEquals(workflowTriggerSetCommand.getName(), "set");

  const options = workflowTriggerSetCommand.getOptions();
  const scheduleOpt = options.find((o) => o.name === "schedule");
  assertEquals(scheduleOpt !== undefined, true);

  const inputOpt = options.find((o) => o.name === "input");
  assertEquals(inputOpt !== undefined, true);
});

Deno.test("parseCatchUpFlags: no flags is no catch-up", async () => {
  const { parseCatchUpFlags } = await import("./workflow_trigger_set.ts");
  assertEquals(parseCatchUpFlags(undefined, undefined), undefined);
});

Deno.test("parseCatchUpFlags: builds a catch-up from policy and max delay", async () => {
  const { parseCatchUpFlags } = await import("./workflow_trigger_set.ts");
  assertEquals(parseCatchUpFlags("latest", "6h"), {
    policy: "latest",
    maxDelay: "6h",
  });
  assertEquals(parseCatchUpFlags("none", undefined), { policy: "none" });
});

Deno.test("parseCatchUpFlags: a max delay without a policy is a user error", async () => {
  const { parseCatchUpFlags } = await import("./workflow_trigger_set.ts");
  assertThrows(
    () => parseCatchUpFlags(undefined, "6h"),
    UserError,
    "--catch-up-max-delay requires --catch-up latest",
  );
});

Deno.test("parseCatchUpFlags: an unknown policy names --catch-up", async () => {
  const { parseCatchUpFlags } = await import("./workflow_trigger_set.ts");
  assertThrows(
    () => parseCatchUpFlags("sometimes", undefined),
    UserError,
    "Invalid --catch-up 'sometimes': expected none or latest",
  );
});

Deno.test("parseCatchUpFlags: latest without a max delay names --catch-up-max-delay", async () => {
  const { parseCatchUpFlags } = await import("./workflow_trigger_set.ts");
  assertThrows(
    () => parseCatchUpFlags("latest", undefined),
    UserError,
    "--catch-up latest requires --catch-up-max-delay",
  );
  assertThrows(
    () => parseCatchUpFlags("latest", "32d"),
    UserError,
    "Invalid --catch-up-max-delay '32d': must be at most 31d",
  );
  assertThrows(
    () => parseCatchUpFlags("none", "6h"),
    UserError,
    "--catch-up-max-delay applies only to --catch-up latest",
  );
});

Deno.test("workflowTriggerSetCommand: has catch-up options", async () => {
  const { workflowTriggerSetCommand } = await import(
    "./workflow_trigger_set.ts"
  );
  const names = workflowTriggerSetCommand.getOptions().map((o) => o.name);
  assertEquals(names.includes("catch-up"), true);
  assertEquals(names.includes("catch-up-max-delay"), true);
});

Deno.test("workflowTriggerSetCommand: keeps serve.yaml's version and federation", async () => {
  const { Command } = await import("@cliffy/command");
  const { withMockedEnv } = await import(
    "../../infrastructure/persistence/path_test_helpers.ts"
  );
  const { readServeConfigFile, writeServeConfigFile } = await import(
    "../../serve/serve_config.ts"
  );
  const { workflowTriggerSetCommand } = await import(
    "./workflow_trigger_set.ts"
  );
  const dir = await Deno.makeTempDir({ prefix: "swamp-trigger-set-" });
  try {
    await writeServeConfigFile(dir, {
      version: 2,
      federation: { hub: "https://hub.example/swamp" },
      port: 9000,
    });
    await withMockedEnv(
      { SWAMP_SERVE_URL: undefined, SWAMP_SERVER_URL: undefined },
      () =>
        new Command()
          .throwErrors()
          .globalOption("--json", "JSON output")
          .command("set", workflowTriggerSetCommand)
          .parse([
            "set",
            "scan-cves",
            "--schedule",
            "0 3 * * *",
            "--json",
            "--repo-dir",
            dir,
          ]),
    );
    const config = await readServeConfigFile(dir);
    assertEquals(config?.version, 2);
    assertEquals(config?.federation, { hub: "https://hub.example/swamp" });
    assertEquals(config?.triggers?.["scan-cves"], { schedule: "0 3 * * *" });
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});
