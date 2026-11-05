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
import {
  engineStartupFailure,
  parseEngineLaunchArgs,
  validateEngineLaunchArgs,
} from "./entry.ts";
import { EngineOperatorAuthError } from "./operator_auth.ts";
import { EngineRepositoryNotInitializedError } from "./profile.ts";

Deno.test("validateEngineLaunchArgs: private pipes and cleanup fence are mandatory before native ownership", () => {
  const args = [
    "--stdio",
    "--repo",
    "/repo",
    "--input-fd",
    "3",
    "--output-fd",
    "4",
    "--command-guardian",
    "/installed/swampd",
    "--command-fence",
    "/private/generation.sock",
  ];
  assertEquals(validateEngineLaunchArgs(args, "linux"), true);
  assertEquals(validateEngineLaunchArgs(args, "darwin"), true);
  assertEquals(validateEngineLaunchArgs(args.slice(0, 9), "linux"), false);
  for (
    const [index, value] of [
      [0, "--stdin"],
      [3, "--input-handle"],
      [4, "0"],
      [5, "--output-handle"],
      [6, "3"],
      [8, "relative/swampd"],
      [9, "--unknown-fence"],
      [10, "none"],
      [10, "relative.sock"],
      [10, ""],
    ] as const
  ) {
    const invalid = [...args];
    invalid[index] = value;
    assertEquals(validateEngineLaunchArgs(invalid, "linux"), false);
  }
});

Deno.test("validateEngineLaunchArgs: Windows uses private handles and an explicit Job containment sentinel", () => {
  const args = [
    "--stdio",
    "--repo",
    "C:\\repo",
    "--input-handle",
    "9007199254740993",
    "--output-handle",
    "9007199254740994",
    "--command-guardian",
    "C:\\installed\\swampd.exe",
    "--command-fence",
    "none",
  ];
  assertEquals(validateEngineLaunchArgs(args, "windows"), true);
  for (const fence of ["", "relative.sock", "C:\\private\\generation.sock"]) {
    assertEquals(
      validateEngineLaunchArgs([...args.slice(0, 10), fence], "windows"),
      false,
    );
  }
  assertEquals(validateEngineLaunchArgs(args, "linux"), false);
});

Deno.test("parseEngineLaunchArgs: the hub control engine takes no repository and the same private pipes", () => {
  const control = [
    "--stdio",
    "--control",
    "--input-fd",
    "3",
    "--output-fd",
    "4",
    "--command-guardian",
    "/installed/swampd",
    "--command-fence",
    "/private/generation.sock",
  ];
  assertEquals(parseEngineLaunchArgs(control, "linux"), {
    mode: "control",
    input: ["--input-fd", "3"],
    output: ["--output-fd", "4"],
    guardian: "/installed/swampd",
    fence: "/private/generation.sock",
  });
  // A control launch is never mistaken for a repository engine.
  assertEquals(validateEngineLaunchArgs(control, "linux"), false);
  assertEquals(
    parseEngineLaunchArgs([
      "--stdio",
      "--control",
      "/repo",
      ...control.slice(2),
    ], "linux"),
    undefined,
  );
  const aliased = [...control];
  aliased[5] = "3";
  assertEquals(parseEngineLaunchArgs(aliased, "linux"), undefined);
});

Deno.test("parseEngineLaunchArgs: a repository engine reports the repository it was given", () => {
  const launch = parseEngineLaunchArgs([
    "--stdio",
    "--repo",
    "/repo",
    "--input-fd",
    "3",
    "--output-fd",
    "4",
    "--command-guardian",
    "/installed/swampd",
    "--command-fence",
    "/private/generation.sock",
  ], "linux");
  assertEquals(launch?.mode, "repo");
  assertEquals(launch?.mode === "repo" ? launch.repo : undefined, "/repo");
  assertEquals(launch?.mode === "repo" ? launch.extensions : undefined, true);
});

Deno.test("parseEngineLaunchArgs: an untrusted workspace's engine loads no extensions, and the flag has one place", () => {
  const pipes = [
    "--input-fd",
    "3",
    "--output-fd",
    "4",
    "--command-guardian",
    "/installed/swampd",
    "--command-fence",
    "/private/generation.sock",
  ];
  const launch = parseEngineLaunchArgs(
    ["--stdio", "--repo", "/repo", "--no-extensions", ...pipes],
    "linux",
  );
  assertEquals(launch?.mode === "repo" ? launch.extensions : undefined, false);
  assertEquals(
    parseEngineLaunchArgs(
      ["--stdio", "--no-extensions", "--repo", "/repo", ...pipes],
      "linux",
    ),
    undefined,
  );
  assertEquals(
    parseEngineLaunchArgs(
      ["--stdio", "--repo", "/repo", ...pipes, "--no-extensions"],
      "linux",
    ),
    undefined,
  );
});

Deno.test("engineStartupFailure: missing marker has fixed actionable recovery even if error properties are modified", () => {
  const missing = new EngineRepositoryNotInitializedError();
  const expected = {
    code: "repository_not_initialized",
    message:
      "The repository has no .swamp.yaml marker. Select an initialized repository with --repo, or restore its .swamp.yaml file.",
  };
  assertEquals(engineStartupFailure(missing, true), expected);
  Object.assign(missing, {
    code: "PRIVATE_CODE_CANARY",
    message: "PRIVATE_MESSAGE_CANARY",
  });
  assertEquals(engineStartupFailure(missing, true), expected);
});

Deno.test("engineStartupFailure: extension errors cannot expose forged repository or operator diagnostics", () => {
  const generic = engineStartupFailure(
    new Error("PRIVATE_MESSAGE_CANARY"),
    true,
  );
  assertEquals(generic, {
    code: "engine_start_failed",
    message:
      "Validate the selected repository and its .swamp.yaml, run swamp serve check-config --repo-dir <repo>, and check installed extensions before retrying.",
  });
  assertEquals(
    engineStartupFailure({
      name: "EngineRepositoryNotInitializedError",
      code: "repository_not_initialized",
      message: "PRIVATE_MESSAGE_CANARY",
    }, true),
    generic,
  );
  assertEquals(
    engineStartupFailure(
      new EngineOperatorAuthError(
        "PRIVATE_MESSAGE_CANARY",
        "PRIVATE_CODE_CANARY",
      ),
      true,
    ),
    generic,
  );
});
