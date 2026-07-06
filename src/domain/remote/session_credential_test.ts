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

import { assertEquals, assertNotEquals } from "@std/assert";
import { SessionCredentialService } from "./session_credential.ts";

function serviceAt(clock: { nowMs: number }, ttlMs = 1000) {
  return new SessionCredentialService({ ttlMs, now: () => clock.nowMs });
}

Deno.test("SessionCredentialService: issue then verify returns the worker id", () => {
  const clock = { nowMs: 0 };
  const service = serviceAt(clock);
  const record = service.issue("worker-1");
  assertEquals(service.verify(record.credential), {
    workerId: "worker-1",
    dispatchId: undefined,
  });
  assertEquals(record.expiresAtMs, 1000);
});

Deno.test("SessionCredentialService: verify rejects unknown credentials", () => {
  const service = serviceAt({ nowMs: 0 });
  assertEquals(service.verify("not-a-credential"), null);
});

Deno.test("SessionCredentialService: verify rejects expired credentials", () => {
  const clock = { nowMs: 0 };
  const service = serviceAt(clock, 1000);
  const record = service.issue("worker-1");
  clock.nowMs = 1000;
  assertEquals(service.verify(record.credential), null);
});

Deno.test("SessionCredentialService: refresh slides the window with a new credential", () => {
  const clock = { nowMs: 0 };
  const service = serviceAt(clock, 1000);
  const first = service.issue("worker-1");
  clock.nowMs = 900;
  const second = service.refresh(first.credential);
  assertNotEquals(second, null);
  assertNotEquals(second!.credential, first.credential);
  assertEquals(second!.expiresAtMs, 1900);
  // The old credential is revoked by the refresh.
  assertEquals(service.verify(first.credential), null);
  assertEquals(service.verify(second!.credential)?.workerId, "worker-1");
});

Deno.test("SessionCredentialService: refresh of an expired credential fails", () => {
  const clock = { nowMs: 0 };
  const service = serviceAt(clock, 1000);
  const record = service.issue("worker-1");
  clock.nowMs = 2000;
  assertEquals(service.refresh(record.credential), null);
});

Deno.test("SessionCredentialService: issue revokes the worker's prior credential", () => {
  const clock = { nowMs: 0 };
  const service = serviceAt(clock);
  const first = service.issue("worker-1");
  const second = service.issue("worker-1");
  assertEquals(service.verify(first.credential), null);
  assertEquals(service.verify(second.credential)?.workerId, "worker-1");
});

Deno.test("SessionCredentialService: revokeForWorker invalidates the credential", () => {
  const clock = { nowMs: 0 };
  const service = serviceAt(clock);
  const record = service.issue("worker-1");
  service.revokeForWorker("worker-1");
  assertEquals(service.verify(record.credential), null);
});

Deno.test("SessionCredentialService: credentials are distinct per worker", () => {
  const clock = { nowMs: 0 };
  const service = serviceAt(clock);
  const a = service.issue("worker-a");
  const b = service.issue("worker-b");
  assertNotEquals(a.credential, b.credential);
  assertEquals(service.verify(a.credential)?.workerId, "worker-a");
  assertEquals(service.verify(b.credential)?.workerId, "worker-b");
});
