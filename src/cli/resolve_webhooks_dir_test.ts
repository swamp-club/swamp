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
import { resolveWebhooksDir } from "./resolve_webhooks_dir.ts";
import type { RepoMarkerData } from "../infrastructure/persistence/repo_marker_repository.ts";

Deno.test("resolveWebhooksDir returns default when no config", () => {
  const saved = Deno.env.get("SWAMP_WEBHOOKS_DIR");
  try {
    Deno.env.delete("SWAMP_WEBHOOKS_DIR");
    assertEquals(resolveWebhooksDir(null), "extensions/webhooks");
  } finally {
    if (saved !== undefined) Deno.env.set("SWAMP_WEBHOOKS_DIR", saved);
  }
});

Deno.test("resolveWebhooksDir uses marker webhooksDir when set", () => {
  const saved = Deno.env.get("SWAMP_WEBHOOKS_DIR");
  try {
    Deno.env.delete("SWAMP_WEBHOOKS_DIR");
    const marker: RepoMarkerData = {
      swampVersion: "0.1.0",
      initializedAt: "2026-01-01T00:00:00Z",
      webhooksDir: "custom/webhooks",
    };
    assertEquals(resolveWebhooksDir(marker), "custom/webhooks");
  } finally {
    if (saved !== undefined) Deno.env.set("SWAMP_WEBHOOKS_DIR", saved);
  }
});

Deno.test("resolveWebhooksDir prefers env var over marker", () => {
  const saved = Deno.env.get("SWAMP_WEBHOOKS_DIR");
  try {
    Deno.env.set("SWAMP_WEBHOOKS_DIR", "env/webhooks");
    const marker: RepoMarkerData = {
      swampVersion: "0.1.0",
      initializedAt: "2026-01-01T00:00:00Z",
      webhooksDir: "custom/webhooks",
    };
    assertEquals(resolveWebhooksDir(marker), "env/webhooks");
  } finally {
    if (saved !== undefined) {
      Deno.env.set("SWAMP_WEBHOOKS_DIR", saved);
    } else {
      Deno.env.delete("SWAMP_WEBHOOKS_DIR");
    }
  }
});
