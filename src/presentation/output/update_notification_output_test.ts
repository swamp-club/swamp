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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { renderUpdateNotification } from "../renderers/update_notification.ts";
import type { UpdateNotification } from "../../domain/update/update_notification_service.ts";

function captureStderr(fn: () => void): string[] {
  const original = console.error;
  const captured: string[] = [];
  console.error = (...args: unknown[]) => {
    captured.push(args.map(String).join(" "));
  };
  try {
    fn();
  } finally {
    console.error = original;
  }
  return captured;
}

Deno.test("renderUpdateNotification shows update_available message", () => {
  const notification: UpdateNotification = {
    type: "update_available",
    currentVersion: "20260206.200442.0-sha.abc123",
    latestVersion: "20260301.120000.0-sha.def456",
  };

  const lines = captureStderr(() => renderUpdateNotification(notification));

  assertEquals(lines[0], "");
  assertStringIncludes(lines[1], "new version of swamp is available");
  assertStringIncludes(lines[1], "`swamp update`");
});

Deno.test("renderUpdateNotification shows version_stale message", () => {
  const notification: UpdateNotification = {
    type: "version_stale",
    currentVersion: "20260106.200442.0-sha.abc123",
    versionAgeDays: 45,
  };

  const lines = captureStderr(() => renderUpdateNotification(notification));

  assertEquals(lines[0], "");
  assertStringIncludes(lines[1], "45 days old");
  assertStringIncludes(lines[1], "`swamp update`");
});
