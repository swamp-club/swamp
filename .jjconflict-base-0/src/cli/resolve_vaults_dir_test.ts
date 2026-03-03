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
import { resolveVaultsDir } from "./resolve_vaults_dir.ts";
import type { RepoMarkerData } from "../infrastructure/persistence/repo_marker_repository.ts";

Deno.test("resolveVaultsDir returns default when no config", () => {
  // Clear env var
  const saved = Deno.env.get("SWAMP_VAULTS_DIR");
  try {
    Deno.env.delete("SWAMP_VAULTS_DIR");
    assertEquals(resolveVaultsDir(null), "extensions/vaults");
  } finally {
    if (saved !== undefined) Deno.env.set("SWAMP_VAULTS_DIR", saved);
  }
});

Deno.test("resolveVaultsDir uses marker vaultsDir when set", () => {
  const saved = Deno.env.get("SWAMP_VAULTS_DIR");
  try {
    Deno.env.delete("SWAMP_VAULTS_DIR");
    const marker: RepoMarkerData = {
      swampVersion: "0.1.0",
      initializedAt: "2026-01-01T00:00:00Z",
      vaultsDir: "custom/vaults",
    };
    assertEquals(resolveVaultsDir(marker), "custom/vaults");
  } finally {
    if (saved !== undefined) Deno.env.set("SWAMP_VAULTS_DIR", saved);
  }
});

Deno.test("resolveVaultsDir prefers env var over marker", () => {
  const saved = Deno.env.get("SWAMP_VAULTS_DIR");
  try {
    Deno.env.set("SWAMP_VAULTS_DIR", "env/vaults");
    const marker: RepoMarkerData = {
      swampVersion: "0.1.0",
      initializedAt: "2026-01-01T00:00:00Z",
      vaultsDir: "custom/vaults",
    };
    assertEquals(resolveVaultsDir(marker), "env/vaults");
  } finally {
    if (saved !== undefined) {
      Deno.env.set("SWAMP_VAULTS_DIR", saved);
    } else {
      Deno.env.delete("SWAMP_VAULTS_DIR");
    }
  }
});
