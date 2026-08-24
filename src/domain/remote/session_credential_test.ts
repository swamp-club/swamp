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

interface FakeInterval {
  id: number;
  cb: () => void;
  ms: number;
}

function serviceAt(clock: { nowMs: number }, ttlMs = 1000) {
  const intervals: FakeInterval[] = [];
  let nextId = 1;
  const service = new SessionCredentialService({
    ttlMs,
    now: () => clock.nowMs,
    setInterval: (cb: () => void, ms: number) => {
      const id = nextId++;
      intervals.push({ id, cb, ms });
      return id;
    },
    clearInterval: (id: number) => {
      const idx = intervals.findIndex((i) => i.id === id);
      if (idx !== -1) intervals.splice(idx, 1);
    },
  });
  return { service, intervals };
}

function serviceAtSimple(clock: { nowMs: number }, ttlMs = 1000) {
  return serviceAt(clock, ttlMs).service;
}

Deno.test("SessionCredentialService: issue then verify returns the worker id", () => {
  const clock = { nowMs: 0 };
  const service = serviceAtSimple(clock);
  const record = service.issue("worker-1");
  assertEquals(service.verify(record.credential), {
    workerId: "worker-1",
    dispatchId: undefined,
  });
  assertEquals(record.expiresAtMs, 1000);
});

Deno.test("SessionCredentialService: verify rejects unknown credentials", () => {
  const service = serviceAtSimple({ nowMs: 0 });
  assertEquals(service.verify("not-a-credential"), null);
});

Deno.test("SessionCredentialService: verify rejects expired credentials", () => {
  const clock = { nowMs: 0 };
  const service = serviceAtSimple(clock, 1000);
  const record = service.issue("worker-1");
  clock.nowMs = 1000;
  assertEquals(service.verify(record.credential), null);
});

Deno.test("SessionCredentialService: refresh slides the window with a new credential", () => {
  const clock = { nowMs: 0 };
  const service = serviceAtSimple(clock, 1000);
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
  const service = serviceAtSimple(clock, 1000);
  const record = service.issue("worker-1");
  clock.nowMs = 2000;
  assertEquals(service.refresh(record.credential), null);
});

Deno.test("SessionCredentialService: issue revokes the worker's prior credential", () => {
  const clock = { nowMs: 0 };
  const service = serviceAtSimple(clock);
  const first = service.issue("worker-1");
  const second = service.issue("worker-1");
  assertEquals(service.verify(first.credential), null);
  assertEquals(service.verify(second.credential)?.workerId, "worker-1");
});

Deno.test("SessionCredentialService: revokeForWorker invalidates the credential", () => {
  const clock = { nowMs: 0 };
  const service = serviceAtSimple(clock);
  const record = service.issue("worker-1");
  service.revokeForWorker("worker-1");
  assertEquals(service.verify(record.credential), null);
});

Deno.test("SessionCredentialService: credentials are distinct per worker", () => {
  const clock = { nowMs: 0 };
  const service = serviceAtSimple(clock);
  const a = service.issue("worker-a");
  const b = service.issue("worker-b");
  assertNotEquals(a.credential, b.credential);
  assertEquals(service.verify(a.credential)?.workerId, "worker-a");
  assertEquals(service.verify(b.credential)?.workerId, "worker-b");
});

Deno.test("SessionCredentialService: issueForDispatch creates a credential with workerId and dispatchId", () => {
  const clock = { nowMs: 0 };
  const service = serviceAtSimple(clock);
  const record = service.issueForDispatch("worker-1", "dispatch-42");
  assertEquals(service.verify(record.credential), {
    workerId: "worker-1",
    dispatchId: "dispatch-42",
  });
});

Deno.test("SessionCredentialService: revokeDispatch revokes only the targeted dispatch credential", () => {
  const clock = { nowMs: 0 };
  const service = serviceAtSimple(clock);
  const control = service.issue("worker-1");
  const d1 = service.issueForDispatch("worker-1", "dispatch-1");
  const d2 = service.issueForDispatch("worker-1", "dispatch-2");

  service.revokeDispatch("worker-1", "dispatch-1");

  assertEquals(service.verify(d1.credential), null);
  assertEquals(service.verify(d2.credential)?.dispatchId, "dispatch-2");
  assertEquals(service.verify(control.credential)?.workerId, "worker-1");
});

Deno.test("SessionCredentialService: revokeAllForWorker revokes control and dispatch credentials", () => {
  const clock = { nowMs: 0 };
  const service = serviceAtSimple(clock);
  const control = service.issue("worker-1");
  const d1 = service.issueForDispatch("worker-1", "dispatch-1");
  const d2 = service.issueForDispatch("worker-1", "dispatch-2");
  const other = service.issue("worker-2");

  service.revokeAllForWorker("worker-1");

  assertEquals(service.verify(control.credential), null);
  assertEquals(service.verify(d1.credential), null);
  assertEquals(service.verify(d2.credential), null);
  assertEquals(service.verify(other.credential)?.workerId, "worker-2");
});

Deno.test("SessionCredentialService: refresh returns null for dispatch credentials", () => {
  const clock = { nowMs: 0 };
  const service = serviceAtSimple(clock);
  const dispatch = service.issueForDispatch("worker-1", "dispatch-1");
  assertEquals(service.refresh(dispatch.credential), null);
  assertEquals(
    service.verify(dispatch.credential)?.dispatchId,
    "dispatch-1",
  );
});

Deno.test("SessionCredentialService: control-channel issue does not revoke dispatch credentials", () => {
  const clock = { nowMs: 0 };
  const service = serviceAtSimple(clock);
  const d1 = service.issueForDispatch("worker-1", "dispatch-1");
  const first = service.issue("worker-1");
  const second = service.issue("worker-1");

  assertEquals(service.verify(first.credential), null);
  assertEquals(service.verify(second.credential)?.workerId, "worker-1");
  assertEquals(service.verify(d1.credential)?.dispatchId, "dispatch-1");
});

Deno.test("SessionCredentialService: revokeDispatch ignores mismatched workerId", () => {
  const clock = { nowMs: 0 };
  const service = serviceAtSimple(clock);
  const d1 = service.issueForDispatch("worker-1", "dispatch-1");

  service.revokeDispatch("worker-2", "dispatch-1");

  assertEquals(service.verify(d1.credential)?.dispatchId, "dispatch-1");
});

Deno.test("SessionCredentialService: expired dispatch credential cleans up secondary indexes", () => {
  const clock = { nowMs: 0 };
  const service = serviceAtSimple(clock, 1000);
  const d1 = service.issueForDispatch("worker-1", "dispatch-1");
  clock.nowMs = 1000;

  assertEquals(service.verify(d1.credential), null);

  const d2 = service.issueForDispatch("worker-1", "dispatch-1");
  assertEquals(service.verify(d2.credential)?.dispatchId, "dispatch-1");
});

Deno.test("SessionCredentialService: revokeAllForWorker then issueForDispatch reuses dispatchId cleanly", () => {
  const clock = { nowMs: 0 };
  const service = serviceAtSimple(clock);
  service.issueForDispatch("worker-1", "dispatch-1");
  service.issueForDispatch("worker-1", "dispatch-2");
  service.issue("worker-1");

  service.revokeAllForWorker("worker-1");

  const fresh = service.issueForDispatch("worker-1", "dispatch-1");
  assertEquals(service.verify(fresh.credential)?.dispatchId, "dispatch-1");
});

Deno.test("SessionCredentialService: interleaved issue and revoke maintains index consistency", () => {
  const clock = { nowMs: 0 };
  const service = serviceAtSimple(clock);

  const c1 = service.issue("worker-1");
  const d1 = service.issueForDispatch("worker-1", "dispatch-1");
  const d2 = service.issueForDispatch("worker-1", "dispatch-2");
  const c2 = service.issue("worker-2");
  const d3 = service.issueForDispatch("worker-2", "dispatch-3");

  service.revokeDispatch("worker-1", "dispatch-1");
  assertEquals(service.verify(d1.credential), null);
  assertEquals(service.verify(d2.credential)?.dispatchId, "dispatch-2");
  assertEquals(service.verify(c1.credential)?.workerId, "worker-1");

  service.revokeAllForWorker("worker-1");
  assertEquals(service.verify(c1.credential), null);
  assertEquals(service.verify(d2.credential), null);

  assertEquals(service.verify(c2.credential)?.workerId, "worker-2");
  assertEquals(service.verify(d3.credential)?.dispatchId, "dispatch-3");
});

// ── Auto-refresh tests ───────────────────────────────────────────────────

Deno.test("SessionCredentialService: dispatch credential auto-refreshes past original TTL", () => {
  const clock = { nowMs: 0 };
  const { service, intervals } = serviceAt(clock, 1000);
  const record = service.issueForDispatch("worker-1", "dispatch-1");

  assertEquals(intervals.length, 1);
  assertEquals(record.expiresAtMs, 1000);

  // Advance past the original TTL and fire the refresh callback
  clock.nowMs = 900;
  intervals[0].cb();
  assertEquals(record.expiresAtMs, 1900);

  // Credential still verifies past the original expiry
  clock.nowMs = 1500;
  assertEquals(service.verify(record.credential)?.dispatchId, "dispatch-1");

  service.dispose();
});

Deno.test("SessionCredentialService: dispatch credential refresh interval matches 2/3 TTL", () => {
  const clock = { nowMs: 0 };
  const { service, intervals } = serviceAt(clock, 3000);
  service.issueForDispatch("worker-1", "dispatch-1");

  assertEquals(intervals.length, 1);
  assertEquals(intervals[0].ms, 2000); // 3000 * 2/3

  service.dispose();
});

Deno.test("SessionCredentialService: revokeDispatch clears the refresh interval", () => {
  const clock = { nowMs: 0 };
  const { service, intervals } = serviceAt(clock, 1000);
  service.issueForDispatch("worker-1", "dispatch-1");

  assertEquals(intervals.length, 1);
  service.revokeDispatch("worker-1", "dispatch-1");
  assertEquals(intervals.length, 0);

  service.dispose();
});

Deno.test("SessionCredentialService: revokeAllForWorker clears all dispatch refresh intervals", () => {
  const clock = { nowMs: 0 };
  const { service, intervals } = serviceAt(clock, 1000);
  service.issueForDispatch("worker-1", "dispatch-1");
  service.issueForDispatch("worker-1", "dispatch-2");
  service.issueForDispatch("worker-2", "dispatch-3");

  assertEquals(intervals.length, 3);
  service.revokeAllForWorker("worker-1");
  assertEquals(intervals.length, 1);
  assertEquals(intervals[0].id, 3); // only dispatch-3 remains

  service.dispose();
});

Deno.test("SessionCredentialService: dispose clears all refresh intervals", () => {
  const clock = { nowMs: 0 };
  const { service, intervals } = serviceAt(clock, 1000);
  service.issueForDispatch("worker-1", "dispatch-1");
  service.issueForDispatch("worker-2", "dispatch-2");

  assertEquals(intervals.length, 2);
  service.dispose();
  assertEquals(intervals.length, 0);
});

Deno.test("SessionCredentialService: refresh callback guards against deleted record", () => {
  const clock = { nowMs: 0 };
  const { service, intervals } = serviceAt(clock, 1000);
  const record = service.issueForDispatch("worker-1", "dispatch-1");

  // Force-expire and verify (which deletes the record)
  clock.nowMs = 1000;
  assertEquals(service.verify(record.credential), null);

  // The interval was cleared by #deleteCredential via verify
  assertEquals(intervals.length, 0);

  service.dispose();
});

Deno.test("SessionCredentialService: concurrent dispatches have independent refresh cycles", () => {
  const clock = { nowMs: 0 };
  const { service, intervals } = serviceAt(clock, 1000);
  const d1 = service.issueForDispatch("worker-1", "dispatch-1");
  const d2 = service.issueForDispatch("worker-1", "dispatch-2");

  assertEquals(intervals.length, 2);

  // Fire only dispatch-1's refresh
  clock.nowMs = 800;
  intervals[0].cb();
  assertEquals(d1.expiresAtMs, 1800);
  assertEquals(d2.expiresAtMs, 1000); // unchanged

  // Revoke dispatch-1, dispatch-2 still has its interval
  service.revokeDispatch("worker-1", "dispatch-1");
  assertEquals(intervals.length, 1);

  // Fire dispatch-2's refresh
  intervals[0].cb();
  assertEquals(d2.expiresAtMs, 1800);

  service.dispose();
});

Deno.test("SessionCredentialService: refresh callback no-ops after revocation race", () => {
  const clock = { nowMs: 0 };
  const { service, intervals } = serviceAt(clock, 1000);
  const record = service.issueForDispatch("worker-1", "dispatch-1");

  // Capture the callback before revocation clears the interval
  const cb = intervals[0].cb;

  // Simulate: revocation happened but callback was already scheduled
  service.revokeDispatch("worker-1", "dispatch-1");

  // Manually fire the callback — should not crash
  cb();

  // Credential is still revoked
  assertEquals(service.verify(record.credential), null);

  service.dispose();
});

Deno.test("SessionCredentialService: control-channel credentials do not get refresh intervals", () => {
  const clock = { nowMs: 0 };
  const { service, intervals } = serviceAt(clock, 1000);
  service.issue("worker-1");

  assertEquals(intervals.length, 0);

  service.dispose();
});
