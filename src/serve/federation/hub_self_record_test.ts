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
import { sampleFingerprint } from "../../domain/serve/federation_test_helpers.ts";
import type { Fingerprint } from "../../domain/serve/fingerprint.ts";
import { createTestHub } from "./federation_hub_test_helpers.ts";
import { HubSelfRecord } from "./hub_self_record.ts";

function hubFingerprint(settingsHash = "0".repeat(64)): Fingerprint {
  return sampleFingerprint({ federationRole: "hub", settingsHash });
}

Deno.test("HubSelfRecord: a node that never leads never writes the hub's record", async () => {
  const t = createTestHub();
  const queued: Array<() => void> = [];
  const record = new HubSelfRecord({
    hub: t.hub,
    fingerprint: () => Promise.resolve(hubFingerprint()),
  });
  record.start((start) => queued.push(start));
  await record.refresh();
  await record.settled();
  assertEquals(record.leading, false);
  assertEquals(t.members.raw("hub"), undefined);
  assertEquals(queued.length, 1);
});

Deno.test("HubSelfRecord: once leading it writes the record, and a reload rewrites it only on change", async () => {
  const t = createTestHub();
  let current = hubFingerprint();
  const queued: Array<() => void> = [];
  const record = new HubSelfRecord({
    hub: t.hub,
    fingerprint: () => Promise.resolve(current),
  });
  record.start((start) => queued.push(start));
  queued[0]();
  await record.settled();
  assertEquals(t.members.raw("hub")!.role, "hub");
  assertEquals(t.members.version("hub"), 1);
  await record.refresh();
  assertEquals(t.members.version("hub"), 1);
  current = hubFingerprint("1".repeat(64));
  await record.refresh();
  assertEquals(t.members.version("hub"), 2);
});

Deno.test("HubSelfRecord: a failed write is logged and the next refresh tries again", async () => {
  const t = createTestHub();
  let fail = true;
  const record = new HubSelfRecord({
    hub: t.hub,
    fingerprint: () =>
      fail
        ? Promise.reject(new Error("vaults unreadable"))
        : Promise.resolve(hubFingerprint()),
  });
  record.start((start) => start());
  await record.settled();
  assertEquals(t.members.raw("hub"), undefined);
  fail = false;
  await record.refresh();
  assertEquals(t.members.version("hub"), 1);
});
