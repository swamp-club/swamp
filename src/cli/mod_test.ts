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
import { resolveModelsDir } from "./mod.ts";

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
