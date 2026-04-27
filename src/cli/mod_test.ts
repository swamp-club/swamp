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

import { assertEquals } from "@std/assert";
import {
  commandNeedsLoaderSetup,
  isLocalhostUrl,
  isTelemetryDisabledByConfig,
  isTelemetryDisabledByEnv,
  isUpdateCheckDisabledByEnv,
  resolveLogLevel,
  resolveModelsDir,
  resolveTelemetryEndpoint,
  resolveWorkflowsDir,
} from "./mod.ts";

Deno.test("resolveModelsDir returns default 'extensions/models' when no config", () => {
  // Ensure env var is not set
  const original = Deno.env.get("SWAMP_MODELS_DIR");
  try {
    Deno.env.delete("SWAMP_MODELS_DIR");

    const result = resolveModelsDir(null);
    assertEquals(result, "extensions/models");
  } finally {
    if (original !== undefined) {
      Deno.env.set("SWAMP_MODELS_DIR", original);
    }
  }
});

Deno.test("resolveModelsDir returns default when marker has no modelsDir", () => {
  const original = Deno.env.get("SWAMP_MODELS_DIR");
  try {
    Deno.env.delete("SWAMP_MODELS_DIR");

    const marker = {
      swampVersion: "0.1.0",
      initializedAt: "2024-01-01T00:00:00Z",
    };
    const result = resolveModelsDir(marker);
    assertEquals(result, "extensions/models");
  } finally {
    if (original !== undefined) {
      Deno.env.set("SWAMP_MODELS_DIR", original);
    }
  }
});

Deno.test("resolveModelsDir uses marker.modelsDir when set", () => {
  const original = Deno.env.get("SWAMP_MODELS_DIR");
  try {
    Deno.env.delete("SWAMP_MODELS_DIR");

    const marker = {
      swampVersion: "0.1.0",
      initializedAt: "2024-01-01T00:00:00Z",
      modelsDir: "custom/models/path",
    };
    const result = resolveModelsDir(marker);
    assertEquals(result, "custom/models/path");
  } finally {
    if (original !== undefined) {
      Deno.env.set("SWAMP_MODELS_DIR", original);
    }
  }
});

Deno.test("resolveModelsDir env var takes priority over marker.modelsDir", () => {
  const original = Deno.env.get("SWAMP_MODELS_DIR");
  try {
    Deno.env.set("SWAMP_MODELS_DIR", "/env/var/path");

    const marker = {
      swampVersion: "0.1.0",
      initializedAt: "2024-01-01T00:00:00Z",
      modelsDir: "custom/models/path",
    };
    const result = resolveModelsDir(marker);
    assertEquals(result, "/env/var/path");
  } finally {
    if (original !== undefined) {
      Deno.env.set("SWAMP_MODELS_DIR", original);
    } else {
      Deno.env.delete("SWAMP_MODELS_DIR");
    }
  }
});

Deno.test("resolveModelsDir env var takes priority over default", () => {
  const original = Deno.env.get("SWAMP_MODELS_DIR");
  try {
    Deno.env.set("SWAMP_MODELS_DIR", "env/models");

    const result = resolveModelsDir(null);
    assertEquals(result, "env/models");
  } finally {
    if (original !== undefined) {
      Deno.env.set("SWAMP_MODELS_DIR", original);
    } else {
      Deno.env.delete("SWAMP_MODELS_DIR");
    }
  }
});

Deno.test("resolveLogLevel returns undefined when no env var and no config", () => {
  const original = Deno.env.get("SWAMP_LOG_LEVEL");
  try {
    Deno.env.delete("SWAMP_LOG_LEVEL");

    const result = resolveLogLevel(null);
    assertEquals(result, undefined);
  } finally {
    if (original !== undefined) {
      Deno.env.set("SWAMP_LOG_LEVEL", original);
    }
  }
});

Deno.test("resolveLogLevel returns undefined when marker has no logLevel", () => {
  const original = Deno.env.get("SWAMP_LOG_LEVEL");
  try {
    Deno.env.delete("SWAMP_LOG_LEVEL");

    const marker = {
      swampVersion: "0.1.0",
      initializedAt: "2024-01-01T00:00:00Z",
    };
    const result = resolveLogLevel(marker);
    assertEquals(result, undefined);
  } finally {
    if (original !== undefined) {
      Deno.env.set("SWAMP_LOG_LEVEL", original);
    }
  }
});

Deno.test("resolveLogLevel returns marker.logLevel when only config is set", () => {
  const original = Deno.env.get("SWAMP_LOG_LEVEL");
  try {
    Deno.env.delete("SWAMP_LOG_LEVEL");

    const marker = {
      swampVersion: "0.1.0",
      initializedAt: "2024-01-01T00:00:00Z",
      logLevel: "warning",
    };
    const result = resolveLogLevel(marker);
    assertEquals(result, "warning");
  } finally {
    if (original !== undefined) {
      Deno.env.set("SWAMP_LOG_LEVEL", original);
    }
  }
});

Deno.test("resolveLogLevel returns env var when set, even if config also has logLevel", () => {
  const original = Deno.env.get("SWAMP_LOG_LEVEL");
  try {
    Deno.env.set("SWAMP_LOG_LEVEL", "debug");

    const marker = {
      swampVersion: "0.1.0",
      initializedAt: "2024-01-01T00:00:00Z",
      logLevel: "error",
    };
    const result = resolveLogLevel(marker);
    assertEquals(result, "debug");
  } finally {
    if (original !== undefined) {
      Deno.env.set("SWAMP_LOG_LEVEL", original);
    } else {
      Deno.env.delete("SWAMP_LOG_LEVEL");
    }
  }
});

Deno.test("resolveLogLevel returns env var when set with no marker", () => {
  const original = Deno.env.get("SWAMP_LOG_LEVEL");
  try {
    Deno.env.set("SWAMP_LOG_LEVEL", "error");

    const result = resolveLogLevel(null);
    assertEquals(result, "error");
  } finally {
    if (original !== undefined) {
      Deno.env.set("SWAMP_LOG_LEVEL", original);
    } else {
      Deno.env.delete("SWAMP_LOG_LEVEL");
    }
  }
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
  const original = Deno.env.get("SWAMP_NO_TELEMETRY");
  try {
    Deno.env.delete("SWAMP_NO_TELEMETRY");
    assertEquals(isTelemetryDisabledByEnv(), false);
  } finally {
    if (original !== undefined) {
      Deno.env.set("SWAMP_NO_TELEMETRY", original);
    }
  }
});

Deno.test("isTelemetryDisabledByEnv returns true when env var is '1'", () => {
  const original = Deno.env.get("SWAMP_NO_TELEMETRY");
  try {
    Deno.env.set("SWAMP_NO_TELEMETRY", "1");
    assertEquals(isTelemetryDisabledByEnv(), true);
  } finally {
    if (original !== undefined) {
      Deno.env.set("SWAMP_NO_TELEMETRY", original);
    } else {
      Deno.env.delete("SWAMP_NO_TELEMETRY");
    }
  }
});

Deno.test("isTelemetryDisabledByEnv returns true when env var is 'true'", () => {
  const original = Deno.env.get("SWAMP_NO_TELEMETRY");
  try {
    Deno.env.set("SWAMP_NO_TELEMETRY", "true");
    assertEquals(isTelemetryDisabledByEnv(), true);
  } finally {
    if (original !== undefined) {
      Deno.env.set("SWAMP_NO_TELEMETRY", original);
    } else {
      Deno.env.delete("SWAMP_NO_TELEMETRY");
    }
  }
});

Deno.test("isTelemetryDisabledByEnv returns false when env var is '0'", () => {
  const original = Deno.env.get("SWAMP_NO_TELEMETRY");
  try {
    Deno.env.set("SWAMP_NO_TELEMETRY", "0");
    assertEquals(isTelemetryDisabledByEnv(), false);
  } finally {
    if (original !== undefined) {
      Deno.env.set("SWAMP_NO_TELEMETRY", original);
    } else {
      Deno.env.delete("SWAMP_NO_TELEMETRY");
    }
  }
});

Deno.test("isTelemetryDisabledByEnv returns false when env var is 'false'", () => {
  const original = Deno.env.get("SWAMP_NO_TELEMETRY");
  try {
    Deno.env.set("SWAMP_NO_TELEMETRY", "false");
    assertEquals(isTelemetryDisabledByEnv(), false);
  } finally {
    if (original !== undefined) {
      Deno.env.set("SWAMP_NO_TELEMETRY", original);
    } else {
      Deno.env.delete("SWAMP_NO_TELEMETRY");
    }
  }
});

Deno.test("isTelemetryDisabledByEnv returns false when env var is ''", () => {
  const original = Deno.env.get("SWAMP_NO_TELEMETRY");
  try {
    Deno.env.set("SWAMP_NO_TELEMETRY", "");
    assertEquals(isTelemetryDisabledByEnv(), false);
  } finally {
    if (original !== undefined) {
      Deno.env.set("SWAMP_NO_TELEMETRY", original);
    } else {
      Deno.env.delete("SWAMP_NO_TELEMETRY");
    }
  }
});

Deno.test("resolveWorkflowsDir returns default 'extensions/workflows' when no config", () => {
  const original = Deno.env.get("SWAMP_WORKFLOWS_DIR");
  try {
    Deno.env.delete("SWAMP_WORKFLOWS_DIR");

    const result = resolveWorkflowsDir(null);
    assertEquals(result, "extensions/workflows");
  } finally {
    if (original !== undefined) {
      Deno.env.set("SWAMP_WORKFLOWS_DIR", original);
    }
  }
});

Deno.test("resolveWorkflowsDir returns default when marker has no workflowsDir", () => {
  const original = Deno.env.get("SWAMP_WORKFLOWS_DIR");
  try {
    Deno.env.delete("SWAMP_WORKFLOWS_DIR");

    const marker = {
      swampVersion: "0.1.0",
      initializedAt: "2024-01-01T00:00:00Z",
    };
    const result = resolveWorkflowsDir(marker);
    assertEquals(result, "extensions/workflows");
  } finally {
    if (original !== undefined) {
      Deno.env.set("SWAMP_WORKFLOWS_DIR", original);
    }
  }
});

Deno.test("resolveWorkflowsDir uses marker.workflowsDir when set", () => {
  const original = Deno.env.get("SWAMP_WORKFLOWS_DIR");
  try {
    Deno.env.delete("SWAMP_WORKFLOWS_DIR");

    const marker = {
      swampVersion: "0.1.0",
      initializedAt: "2024-01-01T00:00:00Z",
      workflowsDir: "custom/workflows/path",
    };
    const result = resolveWorkflowsDir(marker);
    assertEquals(result, "custom/workflows/path");
  } finally {
    if (original !== undefined) {
      Deno.env.set("SWAMP_WORKFLOWS_DIR", original);
    }
  }
});

Deno.test("resolveWorkflowsDir env var takes priority over marker.workflowsDir", () => {
  const original = Deno.env.get("SWAMP_WORKFLOWS_DIR");
  try {
    Deno.env.set("SWAMP_WORKFLOWS_DIR", "/env/var/path");

    const marker = {
      swampVersion: "0.1.0",
      initializedAt: "2024-01-01T00:00:00Z",
      workflowsDir: "custom/workflows/path",
    };
    const result = resolveWorkflowsDir(marker);
    assertEquals(result, "/env/var/path");
  } finally {
    if (original !== undefined) {
      Deno.env.set("SWAMP_WORKFLOWS_DIR", original);
    } else {
      Deno.env.delete("SWAMP_WORKFLOWS_DIR");
    }
  }
});

Deno.test("resolveWorkflowsDir env var takes priority over default", () => {
  const original = Deno.env.get("SWAMP_WORKFLOWS_DIR");
  try {
    Deno.env.set("SWAMP_WORKFLOWS_DIR", "env/workflows");

    const result = resolveWorkflowsDir(null);
    assertEquals(result, "env/workflows");
  } finally {
    if (original !== undefined) {
      Deno.env.set("SWAMP_WORKFLOWS_DIR", original);
    } else {
      Deno.env.delete("SWAMP_WORKFLOWS_DIR");
    }
  }
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

// --- isUpdateCheckDisabledByEnv tests ---

Deno.test("isUpdateCheckDisabledByEnv returns false when env var is not set", () => {
  const original = Deno.env.get("SWAMP_NO_UPDATE_CHECK");
  try {
    Deno.env.delete("SWAMP_NO_UPDATE_CHECK");
    assertEquals(isUpdateCheckDisabledByEnv(), false);
  } finally {
    if (original !== undefined) {
      Deno.env.set("SWAMP_NO_UPDATE_CHECK", original);
    }
  }
});

Deno.test("isUpdateCheckDisabledByEnv returns true when env var is '1'", () => {
  const original = Deno.env.get("SWAMP_NO_UPDATE_CHECK");
  try {
    Deno.env.set("SWAMP_NO_UPDATE_CHECK", "1");
    assertEquals(isUpdateCheckDisabledByEnv(), true);
  } finally {
    if (original !== undefined) {
      Deno.env.set("SWAMP_NO_UPDATE_CHECK", original);
    } else {
      Deno.env.delete("SWAMP_NO_UPDATE_CHECK");
    }
  }
});

Deno.test("isUpdateCheckDisabledByEnv returns true when env var is 'true'", () => {
  const original = Deno.env.get("SWAMP_NO_UPDATE_CHECK");
  try {
    Deno.env.set("SWAMP_NO_UPDATE_CHECK", "true");
    assertEquals(isUpdateCheckDisabledByEnv(), true);
  } finally {
    if (original !== undefined) {
      Deno.env.set("SWAMP_NO_UPDATE_CHECK", original);
    } else {
      Deno.env.delete("SWAMP_NO_UPDATE_CHECK");
    }
  }
});

Deno.test("isUpdateCheckDisabledByEnv returns false when env var is '0'", () => {
  const original = Deno.env.get("SWAMP_NO_UPDATE_CHECK");
  try {
    Deno.env.set("SWAMP_NO_UPDATE_CHECK", "0");
    assertEquals(isUpdateCheckDisabledByEnv(), false);
  } finally {
    if (original !== undefined) {
      Deno.env.set("SWAMP_NO_UPDATE_CHECK", original);
    } else {
      Deno.env.delete("SWAMP_NO_UPDATE_CHECK");
    }
  }
});

Deno.test("isUpdateCheckDisabledByEnv returns false when env var is 'false'", () => {
  const original = Deno.env.get("SWAMP_NO_UPDATE_CHECK");
  try {
    Deno.env.set("SWAMP_NO_UPDATE_CHECK", "false");
    assertEquals(isUpdateCheckDisabledByEnv(), false);
  } finally {
    if (original !== undefined) {
      Deno.env.set("SWAMP_NO_UPDATE_CHECK", original);
    } else {
      Deno.env.delete("SWAMP_NO_UPDATE_CHECK");
    }
  }
});

Deno.test("isUpdateCheckDisabledByEnv returns false when env var is ''", () => {
  const original = Deno.env.get("SWAMP_NO_UPDATE_CHECK");
  try {
    Deno.env.set("SWAMP_NO_UPDATE_CHECK", "");
    assertEquals(isUpdateCheckDisabledByEnv(), false);
  } finally {
    if (original !== undefined) {
      Deno.env.set("SWAMP_NO_UPDATE_CHECK", original);
    } else {
      Deno.env.delete("SWAMP_NO_UPDATE_CHECK");
    }
  }
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

Deno.test("commandNeedsLoaderSetup returns true for model type search with global flags", () => {
  assertEquals(
    commandNeedsLoaderSetup(["--json", "model", "type", "search", "aws"]),
    true,
  );
});
