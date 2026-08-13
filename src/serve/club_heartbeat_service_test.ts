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
  ClubHeartbeatService,
  DEFAULT_CLUB_HEARTBEAT_INTERVAL_MS,
} from "./club_heartbeat_service.ts";

Deno.test("DEFAULT_CLUB_HEARTBEAT_INTERVAL_MS: is 1 hour", () => {
  assertEquals(DEFAULT_CLUB_HEARTBEAT_INTERVAL_MS, 60 * 60 * 1000);
});

Deno.test("ClubHeartbeatService: stop is safe to call before start", () => {
  const service = new ClubHeartbeatService({
    providerUrl: "https://example.com",
    oauthClientId: "test-client",
    intervalMs: 1000,
    getAccessToken: () => Promise.resolve("token"),
    sendHeartbeat: () => Promise.resolve({ heartbeatCount: 1 }),
  });
  service.stop();
});

Deno.test("ClubHeartbeatService: start then stop does not leak timers", () => {
  const service = new ClubHeartbeatService({
    providerUrl: "https://example.com",
    oauthClientId: "test-client",
    intervalMs: 60_000,
    getAccessToken: () => Promise.resolve("token"),
    sendHeartbeat: () => Promise.resolve({ heartbeatCount: 1 }),
  });
  service.start();
  service.stop();
});

Deno.test("ClubHeartbeatService: double start is idempotent", () => {
  const service = new ClubHeartbeatService({
    providerUrl: "https://example.com",
    oauthClientId: "test-client",
    intervalMs: 60_000,
    getAccessToken: () => Promise.resolve("token"),
    sendHeartbeat: () => Promise.resolve({ heartbeatCount: 1 }),
  });
  service.start();
  service.start();
  service.stop();
});
