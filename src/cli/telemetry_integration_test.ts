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

import { assert, assertEquals } from "@std/assert";
import {
  buildInvocationContext,
  extractCommandInfo,
  isExternalDatastoreConfigured,
  isExternalVaultConfigured,
  isTelemetryDisabled,
  projectEnvSnapshot,
} from "./telemetry_integration.ts";
import { withMockedEnv } from "../infrastructure/persistence/path_test_helpers.ts";

Deno.test("extractCommandInfo extracts simple command", () => {
  const info = extractCommandInfo(["model"]);

  assertEquals(info.command, "model");
  assertEquals(info.subcommand, undefined);
  assertEquals(info.args, []);
  assertEquals(info.optionKeys, []);
  assertEquals(info.globalOptions, []);
});

Deno.test("extractCommandInfo extracts command and subcommand", () => {
  const info = extractCommandInfo(["model", "create"]);

  assertEquals(info.command, "model");
  assertEquals(info.subcommand, "create");
  assertEquals(info.args, []);
  assertEquals(info.optionKeys, []);
  assertEquals(info.globalOptions, []);
});

Deno.test("extractCommandInfo records categorical args for model create", () => {
  const info = extractCommandInfo([
    "model",
    "create",
    "prompt",
    "my-model",
  ]);

  assertEquals(info.command, "model");
  assertEquals(info.subcommand, "create");
  assertEquals(info.args, ["prompt", "<REDACTED>"]);
  assertEquals(info.optionKeys, []);
  assertEquals(info.globalOptions, []);
});

Deno.test("extractCommandInfo extracts global options", () => {
  const info = extractCommandInfo([
    "--json",
    "--verbose",
    "model",
    "create",
  ]);

  assertEquals(info.command, "model");
  assertEquals(info.subcommand, "create");
  assertEquals(info.globalOptions, ["--json", "--verbose"]);
  assertEquals(info.optionKeys, []);
});

Deno.test("extractCommandInfo extracts command-specific options", () => {
  const info = extractCommandInfo([
    "model",
    "create",
    "prompt",
    "--repo-dir",
    "/path/to/repo",
    "--force",
  ]);

  assertEquals(info.command, "model");
  assertEquals(info.subcommand, "create");
  assertEquals(info.args, ["prompt"]);
  assertEquals(info.optionKeys, ["--repo-dir", "--force"]);
  assertEquals(info.globalOptions, []);
});

Deno.test("extractCommandInfo handles mixed global and command options", () => {
  const info = extractCommandInfo([
    "--json",
    "workflow",
    "run",
    "my-workflow",
    "--repo-dir",
    "/path",
    "-q",
  ]);

  assertEquals(info.command, "workflow");
  assertEquals(info.subcommand, "run");
  assertEquals(info.args, ["<REDACTED>"]);
  assertEquals(info.optionKeys, ["--repo-dir"]);
  assertEquals(info.globalOptions, ["--json", "-q"]);
});

Deno.test("extractCommandInfo handles option=value syntax", () => {
  const info = extractCommandInfo([
    "model",
    "create",
    "--repo-dir=/path/to/repo",
  ]);

  assertEquals(info.command, "model");
  assertEquals(info.subcommand, "create");
  assertEquals(info.optionKeys, ["--repo-dir"]);

  // The same option *before* the command. This position is the one that used
  // to break: an attached value was not recognised, so the parser skipped the
  // next argument as the option's value and ate the command word. The case
  // above passes either way, which is how it went unnoticed.
  const leading = extractCommandInfo([
    "--repo-dir=/path/to/repo",
    "model",
    "create",
  ]);

  assertEquals(leading.command, "model");
  assertEquals(leading.subcommand, "create");
});

Deno.test("extractCommandInfo: a leading option=value does not swallow the command", () => {
  // Each pair is the same invocation written both ways. They must parse
  // identically — the space-separated form always did, and it passing is what
  // made the attached form look covered (swamp-club#2254).
  const equivalents: Array<{ attached: string[]; spaced: string[] }> = [
    {
      attached: ["--log-level=debug", "invite", "link"],
      spaced: ["--log-level", "debug", "invite", "link"],
    },
    {
      attached: ["--repo-dir=/tmp/x", "invite", "link"],
      spaced: ["--repo-dir", "/tmp/x", "invite", "link"],
    },
    {
      attached: ["--log-level=debug", "vault", "read-secret", "v", "k"],
      spaced: ["--log-level", "debug", "vault", "read-secret", "v", "k"],
    },
  ];

  for (const { attached, spaced } of equivalents) {
    const fromAttached = extractCommandInfo(attached);
    const fromSpaced = extractCommandInfo(spaced);
    assertEquals(fromAttached.command, fromSpaced.command);
    assertEquals(fromAttached.subcommand, fromSpaced.subcommand);
  }

  // A single-word command has no subcommand to lose, so it loses the command
  // itself — this parsed as command "" before the fix.
  const egg = extractCommandInfo(["--log-level=debug", "first-rule"]);
  assertEquals(egg.command, "first-rule");
  assertEquals(egg.subcommand, undefined);
});

Deno.test("extractCommandInfo handles --no-telemetry flag", () => {
  const info = extractCommandInfo([
    "--no-telemetry",
    "model",
    "search",
  ]);

  assertEquals(info.command, "model");
  assertEquals(info.subcommand, "search");
  assertEquals(info.globalOptions, ["--no-telemetry"]);
});

Deno.test("isTelemetryDisabled returns true when flag present", () => {
  assertEquals(
    isTelemetryDisabled(["--no-telemetry", "model", "search"]),
    true,
  );
  assertEquals(
    isTelemetryDisabled(["model", "--no-telemetry", "search"]),
    true,
  );
  assertEquals(
    isTelemetryDisabled(["model", "search", "--no-telemetry"]),
    true,
  );
});

Deno.test("isTelemetryDisabled returns false when flag absent", () => {
  assertEquals(isTelemetryDisabled(["model", "search"]), false);
  assertEquals(isTelemetryDisabled(["--json", "model", "search"]), false);
});

Deno.test("extractCommandInfo records categorical args for model method", () => {
  const info = extractCommandInfo([
    "model",
    "method",
    "run",
    "my-model",
    "train",
  ]);

  assertEquals(info.command, "model");
  assertEquals(info.subcommand, "method");
  assertEquals(info.args, ["run", "<REDACTED>", "train"]);
});

Deno.test("extractCommandInfo records categorical args for behavior run (swamp-club#3265)", () => {
  const info = extractCommandInfo(["behavior", "run", "my-model", "train"]);

  assertEquals(info.command, "behavior");
  assertEquals(info.subcommand, "run");
  assertEquals(info.args, ["<REDACTED>", "train"]);
});

Deno.test("extractCommandInfo classifies the behaviour alias spelling the same way", () => {
  const info = extractCommandInfo(["behaviour", "run", "my-model", "train"]);

  assertEquals(info.command, "behaviour");
  assertEquals(info.subcommand, "run");
  assertEquals(info.args, ["<REDACTED>", "train"]);
});

Deno.test("extractCommandInfo redacts the type and definition name of a direct-type behavior run", () => {
  const info = extractCommandInfo([
    "behavior",
    "run",
    "@swamp/echo",
    "echo",
    "my-def",
    "--input",
    "k=v",
  ]);

  assertEquals(info.args, ["<REDACTED>", "echo", "<REDACTED>"]);
  assertEquals(info.optionKeys, ["--input"]);
});

Deno.test("extractCommandInfo: a boolean run flag before the method does not shift the definition name into the categorical slot", () => {
  for (const command of ["behavior", "behaviour"]) {
    const info = extractCommandInfo([
      command,
      "run",
      "@acme/t",
      "--skip-checks",
      "create",
      "my-secret-def",
    ]);
    assertEquals(info.args, ["<REDACTED>", "create", "<REDACTED>"]);
  }
  const legacy = extractCommandInfo([
    "model",
    "method",
    "run",
    "my-secret-model",
    "--skip-reports",
    "create",
  ]);
  assertEquals(legacy.args, ["run", "<REDACTED>", "create"]);
  const stdin = extractCommandInfo([
    "behavior",
    "run",
    "my-model",
    "--stdin",
    "deploy",
  ]);
  assertEquals(stdin.args, ["<REDACTED>", "deploy"]);
  const literal = extractCommandInfo([
    "behavior",
    "run",
    "@acme/t",
    "--literal-inputs",
    "create",
    "my-secret-def",
  ]);
  assertEquals(literal.args, ["<REDACTED>", "create", "<REDACTED>"]);
});

Deno.test("extractCommandInfo redacts all args for commands without schema", () => {
  const info = extractCommandInfo(["model", "get", "my-model"]);

  assertEquals(info.command, "model");
  assertEquals(info.subcommand, "get");
  assertEquals(info.args, ["<REDACTED>"]);
});

Deno.test("extractCommandInfo redacts all args for unknown commands", () => {
  const info = extractCommandInfo(["foo", "bar", "baz"]);

  assertEquals(info.command, "foo");
  assertEquals(info.subcommand, "bar");
  assertEquals(info.args, ["<REDACTED>"]);
});

Deno.test("extractCommandInfo redacts args beyond schema length", () => {
  const info = extractCommandInfo([
    "model",
    "create",
    "prompt",
    "my-model",
    "extra",
  ]);

  assertEquals(info.command, "model");
  assertEquals(info.subcommand, "create");
  assertEquals(info.args, ["prompt", "<REDACTED>", "<REDACTED>"]);
});

Deno.test("extractCommandInfo records categorical arg for type describe", () => {
  const info = extractCommandInfo(["type", "describe", "prompt"]);

  assertEquals(info.command, "type");
  assertEquals(info.subcommand, "describe");
  assertEquals(info.args, ["prompt"]);
});

Deno.test("extractCommandInfo records categorical arg for vault create", () => {
  const info = extractCommandInfo(["vault", "create", "aws-sm", "my-vault"]);

  assertEquals(info.command, "vault");
  assertEquals(info.subcommand, "create");
  assertEquals(info.args, ["aws-sm", "<REDACTED>"]);
});

Deno.test("extractCommandInfo handles --no-color as boolean flag", () => {
  const info = extractCommandInfo(["--no-color", "model", "create"]);

  assertEquals(info.command, "model");
  assertEquals(info.subcommand, "create");
  assertEquals(info.globalOptions, ["--no-color"]);
});

Deno.test("extractCommandInfo handles --show-properties as boolean flag", () => {
  const info = extractCommandInfo(["--show-properties", "workflow", "run"]);

  assertEquals(info.command, "workflow");
  assertEquals(info.subcommand, "run");
  assertEquals(info.globalOptions, ["--show-properties"]);
});

Deno.test("extractCommandInfo handles --no-color with --json", () => {
  const info = extractCommandInfo([
    "--no-color",
    "--json",
    "model",
    "search",
  ]);

  assertEquals(info.command, "model");
  assertEquals(info.subcommand, "search");
  assertEquals(info.globalOptions, ["--no-color", "--json"]);
});

Deno.test("extractCommandInfo handles --last-evaluated as boolean flag", () => {
  const info = extractCommandInfo([
    "workflow",
    "run",
    "my-workflow",
    "--last-evaluated",
  ]);

  assertEquals(info.command, "workflow");
  assertEquals(info.subcommand, "run");
  assertEquals(info.args, ["<REDACTED>"]);
  assertEquals(info.optionKeys, ["--last-evaluated"]);
});

Deno.test("extractCommandInfo handles --check as boolean flag", () => {
  const info = extractCommandInfo(["update", "--check"]);

  assertEquals(info.command, "update");
  assertEquals(info.subcommand, undefined);
  assertEquals(info.optionKeys, ["--check"]);
});

Deno.test("extractCommandInfo handles --verify and --prune as boolean flags", () => {
  const info = extractCommandInfo(["repo", "index", "--verify", "--prune"]);

  assertEquals(info.command, "repo");
  assertEquals(info.subcommand, "index");
  assertEquals(info.optionKeys, ["--verify", "--prune"]);
});

Deno.test("extractCommandInfo handles --streaming as boolean flag", () => {
  const info = extractCommandInfo(["data", "search", "--streaming"]);

  assertEquals(info.command, "data");
  assertEquals(info.subcommand, "search");
  assertEquals(info.optionKeys, ["--streaming"]);
});

Deno.test("projectEnvSnapshot picks up whitelist keys present on Deno.env", () => {
  // Mock one whitelist key so the projection has something to capture.
  const sentinel = "swamp-test-claude";
  withMockedEnv({ CLAUDE_CODE_ENTRYPOINT: sentinel }, () => {
    const snapshot = projectEnvSnapshot();
    assertEquals(snapshot.CLAUDE_CODE_ENTRYPOINT, sentinel);
  });
});

Deno.test("projectEnvSnapshot does not include keys outside the whitelist", () => {
  // Set a non-whitelist key and assert it does not appear in the projection.
  withMockedEnv(
    { AWS_SECRET_ACCESS_KEY: "AKIA-test-secret-do-not-leak" },
    () => {
      const snapshot = projectEnvSnapshot();
      assert(
        !("AWS_SECRET_ACCESS_KEY" in snapshot),
        "projectEnvSnapshot leaked a non-whitelist key",
      );
    },
  );
});

Deno.test("buildInvocationContext: claude detected, tools configured", () => {
  const ctx = buildInvocationContext(
    { CLAUDECODE: "1" },
    ["claude", "cursor"],
    false,
    undefined,
    false,
  );
  assertEquals(ctx.configuredAiTools, ["claude", "cursor"]);
  assertEquals(ctx.detectedAiTool, "claude");
  assertEquals(ctx.agentSessionDetected, true);
  assertEquals(ctx.externalDatastoreConfigured, false);
  assertEquals(ctx.externalVaultConfigured, false);
});

Deno.test("buildInvocationContext: configuredAiTools=undefined when no marker passed", () => {
  const ctx = buildInvocationContext(
    { CLAUDECODE: "1" },
    undefined,
    false,
    undefined,
    false,
  );
  assertEquals("configuredAiTools" in ctx, false);
  assertEquals(ctx.detectedAiTool, "claude");
  assertEquals(ctx.agentSessionDetected, true);
});

Deno.test("buildInvocationContext: configuredAiTools=[] preserved (legacy opt-out)", () => {
  const ctx = buildInvocationContext({}, [], false, undefined, false);
  assertEquals(ctx.configuredAiTools, []);
  assertEquals("detectedAiTool" in ctx, false);
  assertEquals(ctx.agentSessionDetected, false);
});

Deno.test("buildInvocationContext: generic AGENT fallback flips agentSessionDetected", () => {
  const ctx = buildInvocationContext(
    { AGENT: "1" },
    ["claude"],
    false,
    undefined,
    false,
  );
  assertEquals(ctx.configuredAiTools, ["claude"]);
  assertEquals("detectedAiTool" in ctx, false);
  assertEquals(ctx.agentSessionDetected, true);
});

Deno.test("buildInvocationContext: empty env yields no detection", () => {
  const ctx = buildInvocationContext({}, ["claude"], false, undefined, false);
  assertEquals("detectedAiTool" in ctx, false);
  assertEquals(ctx.agentSessionDetected, false);
});

Deno.test("buildInvocationContext: externalDatastoreConfigured=true is recorded", () => {
  const ctx = buildInvocationContext({}, ["claude"], true, undefined, false);
  assertEquals(ctx.externalDatastoreConfigured, true);
});

Deno.test("buildInvocationContext: datastoreType is recorded", () => {
  const ctx = buildInvocationContext(
    {},
    ["claude"],
    true,
    "@swamp/s3",
    false,
  );
  assertEquals(ctx.datastoreType, "@swamp/s3");
  assertEquals(ctx.externalDatastoreConfigured, true);
});

Deno.test("buildInvocationContext: datastoreType omitted when undefined", () => {
  const ctx = buildInvocationContext({}, ["claude"], false, undefined, false);
  assertEquals("datastoreType" in ctx, false);
});

Deno.test("buildInvocationContext: externalVaultConfigured=true is recorded", () => {
  const ctx = buildInvocationContext({}, ["claude"], false, undefined, true);
  assertEquals(ctx.externalVaultConfigured, true);
});

Deno.test("isExternalDatastoreConfigured: undefined marker datastore is not external", () => {
  assertEquals(isExternalDatastoreConfigured(undefined), false);
});

Deno.test("isExternalDatastoreConfigured: filesystem type is not external", () => {
  assertEquals(
    isExternalDatastoreConfigured({ type: "filesystem", path: "/tmp/ds" }),
    false,
  );
});

Deno.test("isExternalDatastoreConfigured: custom (non-filesystem) type is external", () => {
  assertEquals(
    isExternalDatastoreConfigured({ type: "s3", bucket: "my-bucket" }),
    true,
  );
});

Deno.test("isExternalVaultConfigured: empty vault list is not external", () => {
  assertEquals(isExternalVaultConfigured([]), false);
});

Deno.test("isExternalVaultConfigured: only local_encryption vaults is not external", () => {
  assertEquals(
    isExternalVaultConfigured([
      {
        id: "v1",
        name: "default",
        type: "local_encryption",
        config: {},
        createdAt: "2026-01-01T00:00:00Z",
      },
    ]),
    false,
  );
});

Deno.test("isExternalVaultConfigured: mock vault type is not external", () => {
  assertEquals(
    isExternalVaultConfigured([
      {
        id: "v1",
        name: "test",
        type: "mock",
        config: {},
        createdAt: "2026-01-01T00:00:00Z",
      },
    ]),
    false,
  );
});

Deno.test("isExternalVaultConfigured: external vault type detected", () => {
  assertEquals(
    isExternalVaultConfigured([
      {
        id: "v1",
        name: "default",
        type: "local_encryption",
        config: {},
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "v2",
        name: "aws",
        type: "@swamp/aws-sm",
        config: {},
        createdAt: "2026-01-01T00:00:00Z",
      },
    ]),
    true,
  );
});

Deno.test("isExternalVaultConfigured: all external vaults detected", () => {
  assertEquals(
    isExternalVaultConfigured([
      {
        id: "v1",
        name: "aws",
        type: "@swamp/aws-sm",
        config: {},
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "v2",
        name: "op",
        type: "@swamp/1password",
        config: {},
        createdAt: "2026-01-01T00:00:00Z",
      },
    ]),
    true,
  );
});

Deno.test("extractCommandInfo: --log is a boolean flag and does not swallow the command (swamp-club#3331)", () => {
  const leading = extractCommandInfo(["--log", "model", "get", "my-model"]);
  assertEquals(leading.command, "model");
  assertEquals(leading.subcommand, "get");
  assertEquals(leading.args, ["<REDACTED>"]);
  // --log is not a tracked global option; it only stops value-skipping.
  assertEquals(leading.globalOptions, []);

  const beforeSubcommand = extractCommandInfo([
    "behavior",
    "--log",
    "run",
    "my-model",
    "train",
  ]);
  assertEquals(beforeSubcommand.subcommand, "run");
  assertEquals(beforeSubcommand.optionKeys, ["--log"]);
  assertEquals(beforeSubcommand.args, ["<REDACTED>", "train"]);

  const beforeMethod = extractCommandInfo([
    "model",
    "method",
    "run",
    "my-model",
    "--log",
    "train",
  ]);
  assertEquals(beforeMethod.args, ["run", "<REDACTED>", "train"]);
});

Deno.test("extractCommandInfo: behavior history and output never record a name, under both spellings (swamp-club#3331)", () => {
  // Both groups take a name as their shorthand positional, so neither slot
  // may be categorical. The legacy model schemas record these slots; the
  // behavior entries do not copy that.
  const cases: ReadonlyArray<readonly string[]> = [
    ["history", "my-server"],
    ["history", "get", "my-server"],
    ["history", "logs", "my-server"],
    ["output", "my-server"],
    ["output", "get", "abc123"],
  ];
  for (const words of cases) {
    for (const group of ["behavior", "behaviour"]) {
      const info = extractCommandInfo([group, ...words]);
      assertEquals(info.subcommand, words[0]);
      for (const arg of info.args) {
        assertEquals(arg, "<REDACTED>", `${group} ${words.join(" ")}`);
      }
    }
  }
});

Deno.test("extractCommandInfo: every behavior path is classified like its model twin, under both spellings (swamp-club#3331)", () => {
  const cases: ReadonlyArray<
    readonly [legacy: string[], preferred: string[], args: string[]]
  > = [
    [
      ["model", "create", "aws-ec2", "my-server"],
      ["create", "aws-ec2", "my-server"],
      ["aws-ec2", "<REDACTED>"],
    ],
    [
      ["model", "get", "my-server"],
      ["get", "my-server"],
      ["<REDACTED>"],
    ],
    [
      ["model", "edit", "my-server"],
      ["edit", "my-server"],
      ["<REDACTED>"],
    ],
    [
      ["model", "delete", "my-server"],
      ["delete", "my-server"],
      ["<REDACTED>"],
    ],
    [
      ["model", "validate", "my-server"],
      ["validate", "my-server"],
      ["<REDACTED>"],
    ],
    [
      ["model", "evaluate", "my-server"],
      ["evaluate", "my-server"],
      ["<REDACTED>"],
    ],
    [
      ["model", "search", "aws"],
      ["search", "aws"],
      ["<REDACTED>"],
    ],
    [
      ["model", "list", "aws"],
      ["list", "aws"],
      ["<REDACTED>"],
    ],
    [
      ["model", "cancel", "my-server"],
      ["cancel", "my-server"],
      ["<REDACTED>"],
    ],
    [
      ["model", "type", "describe", "aws-ec2"],
      ["type", "describe", "aws-ec2"],
      ["<REDACTED>", "<REDACTED>"],
    ],
  ];
  for (const [legacyWords, preferredWords, args] of cases) {
    assertEquals(
      extractCommandInfo(legacyWords).args,
      args,
      legacyWords.join(" "),
    );
    for (const group of ["behavior", "behaviour"]) {
      const info = extractCommandInfo([group, ...preferredWords]);
      assertEquals(info.command, group);
      assertEquals(info.subcommand, preferredWords[0]);
      assertEquals(info.args, args, `${group} ${preferredWords.join(" ")}`);
    }
  }

  // `behavior describe` / `history` take the slots after `model method <word>`.
  const legacyDescribe = extractCommandInfo([
    "model",
    "method",
    "describe",
    "my-server",
    "getSystemInfo",
  ]);
  assertEquals(legacyDescribe.args, [
    "describe",
    "<REDACTED>",
    "getSystemInfo",
  ]);
  const legacyHistory = extractCommandInfo([
    "model",
    "method",
    "history",
    "get",
    "abc123",
  ]);
  assertEquals(legacyHistory.args, ["history", "<REDACTED>", "abc123"]);
  for (const group of ["behavior", "behaviour"]) {
    assertEquals(
      extractCommandInfo([group, "describe", "my-server", "getSystemInfo"])
        .args,
      legacyDescribe.args.slice(1),
    );
    // The legacy history schema records the id; behavior history redacts it
    // (see "behavior history and output never record a name").
    assertEquals(
      extractCommandInfo([group, "history", "get", "abc123"]).args,
      ["<REDACTED>", "<REDACTED>"],
    );
  }
});
