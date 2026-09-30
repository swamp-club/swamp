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
  commandNeedsLoaderSetup,
  type DeferredWarning,
  isHookCommand,
  isLocalhostUrl,
  isRepoScopedCommand,
  isTelemetryDisabledByConfig,
  isTelemetryDisabledByEnv,
  isTelemetryOptedOut,
  isTelemetryOptOutInvocation,
  isThinClientCommand,
  isUpdateCheckDisabledByEnv,
  resolveAutoResolverLockfilePath,
  resolveLogLevel,
  resolveModelsDir,
  resolveTelemetryEndpoint,
  resolveWorkflowsDir,
  shouldSuppressMissingExtensionsWarning,
} from "./mod.ts";
import { extractCommandInfo } from "./telemetry_integration.ts";
import { join, resolve } from "@std/path";
import {
  managedConfigLockfilePath,
  registerManagedConfig,
} from "../infrastructure/persistence/paths.ts";
import {
  assertPathEquals,
  withMockedEnv,
} from "../infrastructure/persistence/path_test_helpers.ts";

Deno.test("resolveModelsDir returns default 'extensions/models' when no config", () => {
  // Ensure env var is not set
  withMockedEnv({ SWAMP_MODELS_DIR: undefined }, () => {
    const result = resolveModelsDir(null);
    assertEquals(result, "extensions/models");
  });
});

Deno.test("resolveModelsDir returns default when marker has no modelsDir", () => {
  withMockedEnv({ SWAMP_MODELS_DIR: undefined }, () => {
    const marker = {
      swampVersion: "0.1.0",
      initializedAt: "2024-01-01T00:00:00Z",
    };
    const result = resolveModelsDir(marker);
    assertEquals(result, "extensions/models");
  });
});

Deno.test("resolveModelsDir uses marker.modelsDir when set", () => {
  withMockedEnv({ SWAMP_MODELS_DIR: undefined }, () => {
    const marker = {
      swampVersion: "0.1.0",
      initializedAt: "2024-01-01T00:00:00Z",
      modelsDir: "custom/models/path",
    };
    const result = resolveModelsDir(marker);
    assertEquals(result, "custom/models/path");
  });
});

Deno.test("resolveModelsDir env var takes priority over marker.modelsDir", () => {
  withMockedEnv({ SWAMP_MODELS_DIR: "/env/var/path" }, () => {
    const marker = {
      swampVersion: "0.1.0",
      initializedAt: "2024-01-01T00:00:00Z",
      modelsDir: "custom/models/path",
    };
    const result = resolveModelsDir(marker);
    assertEquals(result, "/env/var/path");
  });
});

Deno.test("resolveModelsDir env var takes priority over default", () => {
  withMockedEnv({ SWAMP_MODELS_DIR: "env/models" }, () => {
    const result = resolveModelsDir(null);
    assertEquals(result, "env/models");
  });
});

Deno.test("resolveLogLevel returns undefined when no env var and no config", () => {
  withMockedEnv({ SWAMP_LOG_LEVEL: undefined }, () => {
    const result = resolveLogLevel(null);
    assertEquals(result, undefined);
  });
});

Deno.test("resolveLogLevel returns undefined when marker has no logLevel", () => {
  withMockedEnv({ SWAMP_LOG_LEVEL: undefined }, () => {
    const marker = {
      swampVersion: "0.1.0",
      initializedAt: "2024-01-01T00:00:00Z",
    };
    const result = resolveLogLevel(marker);
    assertEquals(result, undefined);
  });
});

Deno.test("resolveLogLevel returns marker.logLevel when only config is set", () => {
  withMockedEnv({ SWAMP_LOG_LEVEL: undefined }, () => {
    const marker = {
      swampVersion: "0.1.0",
      initializedAt: "2024-01-01T00:00:00Z",
      logLevel: "warning",
    };
    const result = resolveLogLevel(marker);
    assertEquals(result, "warning");
  });
});

Deno.test("resolveLogLevel returns env var when set, even if config also has logLevel", () => {
  withMockedEnv({ SWAMP_LOG_LEVEL: "debug" }, () => {
    const marker = {
      swampVersion: "0.1.0",
      initializedAt: "2024-01-01T00:00:00Z",
      logLevel: "error",
    };
    const result = resolveLogLevel(marker);
    assertEquals(result, "debug");
  });
});

Deno.test("resolveLogLevel returns env var when set with no marker", () => {
  withMockedEnv({ SWAMP_LOG_LEVEL: "error" }, () => {
    const result = resolveLogLevel(null);
    assertEquals(result, "error");
  });
});

Deno.test("isTelemetryDisabledByConfig returns false for null marker", () => {
  assertEquals(isTelemetryDisabledByConfig(null), false);
});

Deno.test("isTelemetryDisabledByConfig returns false when field is absent", () => {
  const marker = {
    swampVersion: "0.1.0",
    initializedAt: "2024-01-01T00:00:00Z",
  };
  assertEquals(isTelemetryDisabledByConfig(marker), false);
});

Deno.test("isTelemetryDisabledByConfig returns false when field is false", () => {
  const marker = {
    swampVersion: "0.1.0",
    initializedAt: "2024-01-01T00:00:00Z",
    telemetryDisabled: false,
  };
  assertEquals(isTelemetryDisabledByConfig(marker), false);
});

Deno.test("isTelemetryDisabledByConfig returns true when field is true", () => {
  const marker = {
    swampVersion: "0.1.0",
    initializedAt: "2024-01-01T00:00:00Z",
    telemetryDisabled: true,
  };
  assertEquals(isTelemetryDisabledByConfig(marker), true);
});

Deno.test("isTelemetryDisabledByEnv returns false when env var is not set", () => {
  withMockedEnv(
    { SWAMP_NO_TELEMETRY: undefined, DO_NOT_TRACK: undefined },
    () => {
      assertEquals(isTelemetryDisabledByEnv(), false);
    },
  );
});

Deno.test("isTelemetryDisabledByEnv returns true when env var is '1'", () => {
  withMockedEnv({ SWAMP_NO_TELEMETRY: "1", DO_NOT_TRACK: undefined }, () => {
    assertEquals(isTelemetryDisabledByEnv(), true);
  });
});

Deno.test("isTelemetryDisabledByEnv returns true when env var is 'true'", () => {
  withMockedEnv({ SWAMP_NO_TELEMETRY: "true", DO_NOT_TRACK: undefined }, () => {
    assertEquals(isTelemetryDisabledByEnv(), true);
  });
});

Deno.test("isTelemetryDisabledByEnv returns false when env var is '0'", () => {
  withMockedEnv({ SWAMP_NO_TELEMETRY: "0", DO_NOT_TRACK: undefined }, () => {
    assertEquals(isTelemetryDisabledByEnv(), false);
  });
});

Deno.test("isTelemetryDisabledByEnv returns false when env var is 'false'", () => {
  withMockedEnv(
    { SWAMP_NO_TELEMETRY: "false", DO_NOT_TRACK: undefined },
    () => {
      assertEquals(isTelemetryDisabledByEnv(), false);
    },
  );
});

Deno.test("isTelemetryDisabledByEnv returns false when env var is ''", () => {
  withMockedEnv({ SWAMP_NO_TELEMETRY: "", DO_NOT_TRACK: undefined }, () => {
    assertEquals(isTelemetryDisabledByEnv(), false);
  });
});

Deno.test("resolveWorkflowsDir returns default 'extensions/workflows' when no config", () => {
  withMockedEnv({ SWAMP_WORKFLOWS_DIR: undefined }, () => {
    const result = resolveWorkflowsDir(null);
    assertEquals(result, "extensions/workflows");
  });
});

Deno.test("resolveWorkflowsDir returns default when marker has no workflowsDir", () => {
  withMockedEnv({ SWAMP_WORKFLOWS_DIR: undefined }, () => {
    const marker = {
      swampVersion: "0.1.0",
      initializedAt: "2024-01-01T00:00:00Z",
    };
    const result = resolveWorkflowsDir(marker);
    assertEquals(result, "extensions/workflows");
  });
});

Deno.test("resolveWorkflowsDir uses marker.workflowsDir when set", () => {
  withMockedEnv({ SWAMP_WORKFLOWS_DIR: undefined }, () => {
    const marker = {
      swampVersion: "0.1.0",
      initializedAt: "2024-01-01T00:00:00Z",
      workflowsDir: "custom/workflows/path",
    };
    const result = resolveWorkflowsDir(marker);
    assertEquals(result, "custom/workflows/path");
  });
});

Deno.test("resolveWorkflowsDir env var takes priority over marker.workflowsDir", () => {
  withMockedEnv({ SWAMP_WORKFLOWS_DIR: "/env/var/path" }, () => {
    const marker = {
      swampVersion: "0.1.0",
      initializedAt: "2024-01-01T00:00:00Z",
      workflowsDir: "custom/workflows/path",
    };
    const result = resolveWorkflowsDir(marker);
    assertEquals(result, "/env/var/path");
  });
});

Deno.test("resolveWorkflowsDir env var takes priority over default", () => {
  withMockedEnv({ SWAMP_WORKFLOWS_DIR: "env/workflows" }, () => {
    const result = resolveWorkflowsDir(null);
    assertEquals(result, "env/workflows");
  });
});

// --- isLocalhostUrl tests ---

Deno.test("isLocalhostUrl returns true for http://localhost", () => {
  assertEquals(isLocalhostUrl("http://localhost"), true);
});

Deno.test("isLocalhostUrl returns true for http://localhost:3000", () => {
  assertEquals(isLocalhostUrl("http://localhost:3000"), true);
});

Deno.test("isLocalhostUrl returns true for http://127.0.0.1:3000", () => {
  assertEquals(isLocalhostUrl("http://127.0.0.1:3000"), true);
});

Deno.test("isLocalhostUrl returns true for http://[::1]:3000", () => {
  assertEquals(isLocalhostUrl("http://[::1]:3000"), true);
});

Deno.test("isLocalhostUrl returns false for https://swamp-club.com", () => {
  assertEquals(isLocalhostUrl("https://swamp-club.com"), false);
});

Deno.test("isLocalhostUrl returns false for https://example.com", () => {
  assertEquals(isLocalhostUrl("https://example.com"), false);
});

Deno.test("isLocalhostUrl returns false for invalid URL", () => {
  assertEquals(isLocalhostUrl("not-a-url"), false);
});

Deno.test("isLocalhostUrl returns false for empty string", () => {
  assertEquals(isLocalhostUrl(""), false);
});

// --- resolveTelemetryEndpoint tests ---

Deno.test("resolveTelemetryEndpoint returns marker endpoint when set", () => {
  const result = resolveTelemetryEndpoint(
    "https://custom.endpoint",
    "http://localhost:3000",
  );
  assertEquals(result, "https://custom.endpoint");
});

Deno.test("resolveTelemetryEndpoint returns localhost endpoint when auth serverUrl is localhost", () => {
  const result = resolveTelemetryEndpoint(undefined, "http://localhost:3000");
  assertEquals(result, "http://localhost:8080");
});

Deno.test("resolveTelemetryEndpoint returns default when auth serverUrl is remote", () => {
  const result = resolveTelemetryEndpoint(
    undefined,
    "https://swamp-club.com",
  );
  assertEquals(result, "https://telemetry.swamp-club.com");
});

Deno.test("resolveTelemetryEndpoint returns default when auth serverUrl is null", () => {
  const result = resolveTelemetryEndpoint(undefined, null);
  assertEquals(result, "https://telemetry.swamp-club.com");
});

Deno.test("resolveTelemetryEndpoint env override wins over marker and auto-detect", () => {
  const result = resolveTelemetryEndpoint(
    "https://marker.endpoint",
    "http://localhost:3000",
    "http://telemetry:8080",
  );
  assertEquals(result, "http://telemetry:8080");
});

Deno.test("resolveTelemetryEndpoint routes a remote-server (container) run when env is set", () => {
  const result = resolveTelemetryEndpoint(
    undefined,
    "http://app:5173",
    "http://telemetry:8080",
  );
  assertEquals(result, "http://telemetry:8080");
});

Deno.test("resolveTelemetryEndpoint ignores an empty env override", () => {
  const result = resolveTelemetryEndpoint("https://marker.endpoint", null, "");
  assertEquals(result, "https://marker.endpoint");
});

// --- isUpdateCheckDisabledByEnv tests ---

Deno.test("isUpdateCheckDisabledByEnv returns false when env var is not set", () => {
  withMockedEnv({ SWAMP_NO_UPDATE_CHECK: undefined }, () => {
    assertEquals(isUpdateCheckDisabledByEnv(), false);
  });
});

Deno.test("isUpdateCheckDisabledByEnv returns true when env var is '1'", () => {
  withMockedEnv({ SWAMP_NO_UPDATE_CHECK: "1" }, () => {
    assertEquals(isUpdateCheckDisabledByEnv(), true);
  });
});

Deno.test("isUpdateCheckDisabledByEnv returns true when env var is 'true'", () => {
  withMockedEnv({ SWAMP_NO_UPDATE_CHECK: "true" }, () => {
    assertEquals(isUpdateCheckDisabledByEnv(), true);
  });
});

Deno.test("isUpdateCheckDisabledByEnv returns false when env var is '0'", () => {
  withMockedEnv({ SWAMP_NO_UPDATE_CHECK: "0" }, () => {
    assertEquals(isUpdateCheckDisabledByEnv(), false);
  });
});

Deno.test("isUpdateCheckDisabledByEnv returns false when env var is 'false'", () => {
  withMockedEnv({ SWAMP_NO_UPDATE_CHECK: "false" }, () => {
    assertEquals(isUpdateCheckDisabledByEnv(), false);
  });
});

Deno.test("isUpdateCheckDisabledByEnv returns false when env var is ''", () => {
  withMockedEnv({ SWAMP_NO_UPDATE_CHECK: "" }, () => {
    assertEquals(isUpdateCheckDisabledByEnv(), false);
  });
});

Deno.test("commandNeedsLoaderSetup returns false for empty args (bare swamp)", () => {
  assertEquals(commandNeedsLoaderSetup([]), false);
});

Deno.test("commandNeedsLoaderSetup returns false for help", () => {
  assertEquals(commandNeedsLoaderSetup(["help"]), false);
});

Deno.test("commandNeedsLoaderSetup returns false for version", () => {
  assertEquals(commandNeedsLoaderSetup(["version"]), false);
});

Deno.test("commandNeedsLoaderSetup returns false for completions subcommand", () => {
  assertEquals(commandNeedsLoaderSetup(["completions", "bash"]), false);
});

Deno.test("commandNeedsLoaderSetup returns false for init", () => {
  assertEquals(commandNeedsLoaderSetup(["init"]), false);
});

Deno.test("commandNeedsLoaderSetup returns false for update", () => {
  assertEquals(commandNeedsLoaderSetup(["update"]), false);
});

Deno.test("commandNeedsLoaderSetup returns false for auth", () => {
  assertEquals(commandNeedsLoaderSetup(["auth"]), false);
});

Deno.test("commandNeedsLoaderSetup returns false for telemetry", () => {
  assertEquals(commandNeedsLoaderSetup(["telemetry"]), false);
});

Deno.test("commandNeedsLoaderSetup returns false for issue", () => {
  assertEquals(commandNeedsLoaderSetup(["issue"]), false);
});

Deno.test("commandNeedsLoaderSetup returns true for model command", () => {
  assertEquals(commandNeedsLoaderSetup(["model", "create"]), true);
});

Deno.test("commandNeedsLoaderSetup returns true for workflow command", () => {
  assertEquals(commandNeedsLoaderSetup(["workflow", "run"]), true);
});

Deno.test("commandNeedsLoaderSetup returns true for data command", () => {
  assertEquals(commandNeedsLoaderSetup(["data", "list"]), true);
});

Deno.test("commandNeedsLoaderSetup returns false for version with global flags", () => {
  assertEquals(commandNeedsLoaderSetup(["--json", "version"]), false);
});

Deno.test("commandNeedsLoaderSetup returns false for audit record (hook command)", () => {
  assertEquals(
    commandNeedsLoaderSetup(["audit", "record", "--from-hook"]),
    false,
  );
});

Deno.test("commandNeedsLoaderSetup returns true for audit (timeline viewer)", () => {
  assertEquals(commandNeedsLoaderSetup(["audit"]), true);
});

Deno.test("commandNeedsLoaderSetup returns true for model type search with global flags", () => {
  assertEquals(
    commandNeedsLoaderSetup(["--json", "model", "type", "search", "aws"]),
    true,
  );
});

// isHookCommand tests

Deno.test("isHookCommand: returns true for audit record --from-hook", () => {
  assertEquals(
    isHookCommand(extractCommandInfo(["audit", "record", "--from-hook"])),
    true,
  );
});

Deno.test("isHookCommand: returns true for audit record with --tool and --repo-dir", () => {
  assertEquals(
    isHookCommand(
      extractCommandInfo([
        "audit",
        "record",
        "--from-hook",
        "--tool",
        "cursor",
        "--repo-dir",
        "/tmp/repo",
      ]),
    ),
    true,
  );
});

Deno.test("isHookCommand: returns false for audit timeline viewer", () => {
  assertEquals(
    isHookCommand(extractCommandInfo(["audit"])),
    false,
  );
});

Deno.test("isHookCommand: returns false for model command", () => {
  assertEquals(
    isHookCommand(extractCommandInfo(["model", "create"])),
    false,
  );
});

Deno.test("isHookCommand: returns false for empty args", () => {
  assertEquals(
    isHookCommand(extractCommandInfo([])),
    false,
  );
});

// shouldSuppressMissingExtensionsWarning tests

const missingPulledWarning: DeferredWarning = {
  kind: "extensions",
  file: "models/upstream_extensions.json",
  error:
    "3 pulled extension(s) have missing source files: @foo/bar, @baz/qux, @a/b (e.g. .swamp/pulled-extensions/models/@foo/bar/mod.ts). Run 'swamp extension install' to restore them.",
};

const missingHomeWarning: DeferredWarning = {
  kind: "extensions",
  file: "",
  error: "Extension loading is unavailable: no swamp data directory found",
};

const modelWarning: DeferredWarning = {
  kind: "model",
  file: "models/foo.ts",
  error: "Failed to load user model",
};

Deno.test("shouldSuppressMissingExtensionsWarning: suppresses for extension install", () => {
  assertEquals(
    shouldSuppressMissingExtensionsWarning(
      extractCommandInfo(["extension", "install"]),
      missingPulledWarning,
    ),
    true,
  );
});

Deno.test("shouldSuppressMissingExtensionsWarning: suppresses for extension install with flags", () => {
  assertEquals(
    shouldSuppressMissingExtensionsWarning(
      extractCommandInfo(["--json", "extension", "install", "--quiet"]),
      missingPulledWarning,
    ),
    true,
  );
});

Deno.test("shouldSuppressMissingExtensionsWarning: does not suppress for extension pull", () => {
  assertEquals(
    shouldSuppressMissingExtensionsWarning(
      extractCommandInfo(["extension", "pull"]),
      missingPulledWarning,
    ),
    false,
  );
});

Deno.test("shouldSuppressMissingExtensionsWarning: does not suppress for model run", () => {
  assertEquals(
    shouldSuppressMissingExtensionsWarning(
      extractCommandInfo(["model", "method", "run"]),
      missingPulledWarning,
    ),
    false,
  );
});

Deno.test("shouldSuppressMissingExtensionsWarning: does not suppress missing-home warning during extension install", () => {
  assertEquals(
    shouldSuppressMissingExtensionsWarning(
      extractCommandInfo(["extension", "install"]),
      missingHomeWarning,
    ),
    false,
  );
});

Deno.test("shouldSuppressMissingExtensionsWarning: does not suppress non-extensions warnings", () => {
  assertEquals(
    shouldSuppressMissingExtensionsWarning(
      extractCommandInfo(["extension", "install"]),
      modelWarning,
    ),
    false,
  );
});

Deno.test("resolveAutoResolverLockfilePath: records in the in-repo lockfile on an extension-backed datastore", () => {
  // Registration is keyed by repo path, so a unique path keeps repeats and
  // other tests independent.
  const repoDir = resolve(`repo-${crypto.randomUUID()}`);
  const base = resolve(`cache-${crypto.randomUUID()}`, "config");
  registerManagedConfig(repoDir, true, base, true);
  const marker = (type: string) => ({
    swampVersion: "0.1.0",
    initializedAt: "2024-01-01",
    datastore: { type, managedConfig: true },
  });

  assertPathEquals(
    resolveAutoResolverLockfilePath(
      repoDir,
      marker("@swamp/s3-datastore"),
      () => undefined,
    ),
    managedConfigLockfilePath(repoDir),
  );
  assertPathEquals(
    resolveAutoResolverLockfilePath(
      repoDir,
      marker("filesystem"),
      () => undefined,
    ),
    join(base, "upstream_extensions.json"),
  );
});

// ── isThinClientCommand (swamp-club#2483) ───────────────────────────────────

const noEnv = () => undefined;

Deno.test("isThinClientCommand: the --server flag marks a thin client", () => {
  assertEquals(
    isThinClientCommand(
      extractCommandInfo(["model", "get", "x", "--server", "https://s"]),
      noEnv,
    ),
    true,
  );
  assertEquals(
    isThinClientCommand(
      extractCommandInfo(["model", "get", "x", "--server=https://s"]),
      noEnv,
    ),
    true,
  );
});

Deno.test("isThinClientCommand: SWAMP_SERVE_URL and SWAMP_SERVER_URL mark a thin client", () => {
  const info = extractCommandInfo(["model", "get", "x"]);
  assertEquals(
    isThinClientCommand(
      info,
      (n) => n === "SWAMP_SERVE_URL" ? "https://s" : undefined,
    ),
    true,
  );
  assertEquals(
    isThinClientCommand(
      info,
      (n) => n === "SWAMP_SERVER_URL" ? "https://s" : undefined,
    ),
    true,
  );
});

Deno.test("isThinClientCommand: local commands and serve are not thin clients", () => {
  assertEquals(
    isThinClientCommand(extractCommandInfo(["model", "get", "x"]), noEnv),
    false,
  );
  assertEquals(
    isThinClientCommand(
      extractCommandInfo(["serve"]),
      (n) => n === "SWAMP_SERVE_URL" ? "https://s" : undefined,
    ),
    false,
  );
});

Deno.test("isTelemetryDisabledByEnv honours DO_NOT_TRACK like SWAMP_NO_TELEMETRY", () => {
  for (
    const [value, expected] of [
      ["1", true],
      ["true", true],
      ["0", false],
      ["false", false],
      ["", false],
      [undefined, false],
    ] as const
  ) {
    withMockedEnv(
      { SWAMP_NO_TELEMETRY: undefined, DO_NOT_TRACK: value },
      () => {
        assertEquals(
          isTelemetryDisabledByEnv(),
          expected,
          `DO_NOT_TRACK=${value}`,
        );
      },
    );
  }
});

Deno.test("isTelemetryOptedOut: any source opts out and none turns it back on", () => {
  const marker = {
    swampVersion: "0.1.0",
    initializedAt: "2024-01-01T00:00:00Z",
  };
  const optedOutMarker = { ...marker, telemetryDisabled: true };

  const cases = [
    // Nothing opts out.
    { marker, userDisabled: false, explicit: false, scoped: true, out: false },
    {
      marker: null,
      userDisabled: false,
      explicit: false,
      scoped: true,
      out: false,
    },
    // The user setting applies inside a repo as well as outside one.
    { marker, userDisabled: true, explicit: false, scoped: true, out: true },
    {
      marker: null,
      userDisabled: true,
      explicit: false,
      scoped: false,
      out: true,
    },
    // The repo marker opts out whatever the user setting is.
    {
      marker: optedOutMarker,
      userDisabled: false,
      explicit: false,
      scoped: true,
      out: true,
    },
    {
      marker: optedOutMarker,
      userDisabled: true,
      explicit: true,
      scoped: true,
      out: true,
    },
    // An explicit repo dir with no marker opts a repo-scoped command out...
    {
      marker: null,
      userDisabled: false,
      explicit: true,
      scoped: true,
      out: true,
    },
    // ...but not a repo-less command or repo init.
    {
      marker: null,
      userDisabled: false,
      explicit: true,
      scoped: false,
      out: false,
    },
    // An explicit repo dir that resolves a marker is an ordinary repo run.
    { marker, userDisabled: false, explicit: true, scoped: true, out: false },
  ];
  for (const c of cases) {
    assertEquals(
      isTelemetryOptedOut({
        marker: c.marker,
        userDisabled: c.userDisabled,
        explicitRepoDir: c.explicit,
        repoScoped: c.scoped,
      }),
      c.out,
      JSON.stringify(c),
    );
  }
});

Deno.test("isRepoScopedCommand: repo-less commands and repo init are not repo-scoped", () => {
  assertEquals(
    isRepoScopedCommand({ command: "model", subcommand: "run" }),
    true,
  );
  assertEquals(
    isRepoScopedCommand({ command: "repo", subcommand: "upgrade" }),
    true,
  );
  assertEquals(
    isRepoScopedCommand({ command: "repo", subcommand: "init" }),
    false,
  );
  assertEquals(isRepoScopedCommand({ command: "init" }), false);
  for (const command of ["auth", "config", "issue", "telemetry", "update"]) {
    assertEquals(isRepoScopedCommand({ command }), false, command);
  }
});

Deno.test("isTelemetryOptOutInvocation: only config set telemetry.collection disabled", () => {
  const configSet = { command: "config", subcommand: "set" };
  assertEquals(
    isTelemetryOptOutInvocation(configSet, [
      "config",
      "set",
      "telemetry.collection",
      "disabled",
    ]),
    true,
  );
  assertEquals(
    isTelemetryOptOutInvocation(configSet, [
      "config",
      "set",
      "telemetry.collection",
      "enabled",
    ]),
    false,
  );
  assertEquals(
    isTelemetryOptOutInvocation(configSet, [
      "config",
      "set",
      "update.auto",
      "disabled",
    ]),
    false,
  );
  assertEquals(
    isTelemetryOptOutInvocation({ command: "config", subcommand: "get" }, [
      "config",
      "get",
      "telemetry.collection",
    ]),
    false,
  );
});
