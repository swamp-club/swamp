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
  isTelemetryDisabledByConfig,
  isTelemetryDisabledByEnv,
  resolveLogLevel,
  resolveModelsDir,
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
