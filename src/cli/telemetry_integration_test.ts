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
  isTelemetryDisabled,
  projectEnvSnapshot,
} from "./telemetry_integration.ts";

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
  // Touch one whitelist key in this process so the projection has something
  // to capture. Restore in a finally so we don't leak into sibling tests.
  const sentinel = "swamp-test-claude";
  const previous = Deno.env.get("CLAUDE_CODE_ENTRYPOINT");
  Deno.env.set("CLAUDE_CODE_ENTRYPOINT", sentinel);
  try {
    const snapshot = projectEnvSnapshot();
    assertEquals(snapshot.CLAUDE_CODE_ENTRYPOINT, sentinel);
  } finally {
    if (previous === undefined) {
      Deno.env.delete("CLAUDE_CODE_ENTRYPOINT");
    } else {
      Deno.env.set("CLAUDE_CODE_ENTRYPOINT", previous);
    }
  }
});

Deno.test("projectEnvSnapshot does not include keys outside the whitelist", () => {
  // Set a non-whitelist key and assert it does not appear in the projection.
  const previous = Deno.env.get("AWS_SECRET_ACCESS_KEY");
  Deno.env.set("AWS_SECRET_ACCESS_KEY", "AKIA-test-secret-do-not-leak");
  try {
    const snapshot = projectEnvSnapshot();
    assert(
      !("AWS_SECRET_ACCESS_KEY" in snapshot),
      "projectEnvSnapshot leaked a non-whitelist key",
    );
  } finally {
    if (previous === undefined) {
      Deno.env.delete("AWS_SECRET_ACCESS_KEY");
    } else {
      Deno.env.set("AWS_SECRET_ACCESS_KEY", previous);
    }
  }
});

Deno.test("buildInvocationContext: claude detected, tools configured", () => {
  const ctx = buildInvocationContext(
    { CLAUDECODE: "1" },
    ["claude", "cursor"],
    false,
  );
  assertEquals(ctx.configuredAiTools, ["claude", "cursor"]);
  assertEquals(ctx.detectedAiTool, "claude");
  assertEquals(ctx.agentSessionDetected, true);
  assertEquals(ctx.externalDatastoreConfigured, false);
});

Deno.test("buildInvocationContext: configuredAiTools=undefined when no marker passed", () => {
  const ctx = buildInvocationContext({ CLAUDECODE: "1" }, undefined, false);
  assertEquals("configuredAiTools" in ctx, false);
  assertEquals(ctx.detectedAiTool, "claude");
  assertEquals(ctx.agentSessionDetected, true);
});

Deno.test("buildInvocationContext: configuredAiTools=[] preserved (legacy opt-out)", () => {
  const ctx = buildInvocationContext({}, [], false);
  assertEquals(ctx.configuredAiTools, []);
  assertEquals("detectedAiTool" in ctx, false);
  assertEquals(ctx.agentSessionDetected, false);
});

Deno.test("buildInvocationContext: generic AGENT fallback flips agentSessionDetected", () => {
  const ctx = buildInvocationContext({ AGENT: "1" }, ["claude"], false);
  assertEquals(ctx.configuredAiTools, ["claude"]);
  assertEquals("detectedAiTool" in ctx, false);
  assertEquals(ctx.agentSessionDetected, true);
});

Deno.test("buildInvocationContext: empty env yields no detection", () => {
  const ctx = buildInvocationContext({}, ["claude"], false);
  assertEquals("detectedAiTool" in ctx, false);
  assertEquals(ctx.agentSessionDetected, false);
});

Deno.test("buildInvocationContext: externalDatastoreConfigured=true is recorded", () => {
  const ctx = buildInvocationContext({}, ["claude"], true);
  assertEquals(ctx.externalDatastoreConfigured, true);
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
