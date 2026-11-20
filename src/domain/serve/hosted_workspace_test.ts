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

import { assert, assertEquals, assertThrows } from "@std/assert";
import { UserError } from "../errors.ts";
import {
  hostedWantedOf,
  HostedWorkspace,
  type HostedWorkspaceWanted,
  serveWantedOf,
  serveWantedOfRecord,
} from "./hosted_workspace.ts";

const T1 = new Date("2026-11-17T10:00:00.000Z");
const T2 = new Date("2026-11-17T11:00:00.000Z");
const T3 = new Date("2026-11-17T12:00:00.000Z");

Deno.test("HostedWorkspace.active: is active with no creator or time", () => {
  assertEquals(HostedWorkspace.active("edge-dns").toRecord(), {
    name: "edge-dns",
    creator: null,
    wanted: "active",
    changedAt: null,
  });
});

Deno.test("HostedWorkspace.create: records the creator and the time", () => {
  assertEquals(HostedWorkspace.create("edge-dns", "alice", T1).toRecord(), {
    name: "edge-dns",
    creator: "alice",
    wanted: "active",
    changedAt: T1.toISOString(),
  });
});

Deno.test("HostedWorkspace.create: refuses an empty creator, which the wanted file could not hold", () => {
  assertThrows(() => HostedWorkspace.create("edge-dns", "", T1), UserError);
  assertThrows(
    () =>
      HostedWorkspace.fromRecord({
        name: "edge-dns",
        creator: "",
        wanted: "active",
        changedAt: null,
      }),
    UserError,
  );
});

Deno.test("HostedWorkspace.fromRecord: refuses an invalid name or wanted state", () => {
  assertThrows(
    () =>
      HostedWorkspace.fromRecord({
        name: "../etc",
        creator: null,
        wanted: "active",
        changedAt: null,
      }),
    UserError,
  );
  assertThrows(
    () =>
      HostedWorkspace.fromRecord({
        name: "edge-dns",
        creator: null,
        wanted: "paused" as unknown as HostedWorkspaceWanted,
        changedAt: null,
      }),
    UserError,
    "active, suspended or deleted",
  );
});

Deno.test("HostedWorkspace.suspend: records the time and keeps the creator; suspending again records the new time", () => {
  const created = HostedWorkspace.create("edge-dns", "alice", T1);
  const suspended = created.suspend(T2);
  assertEquals(suspended.wanted, "suspended");
  assertEquals(suspended.creator, "alice");
  assertEquals(suspended.changedAt, T2.toISOString());
  const again = suspended.suspend(T3);
  assertEquals(again.wanted, "suspended");
  assertEquals(again.changedAt, T3.toISOString());
  assertEquals(created.wanted, "active", "the original is unchanged");
});

Deno.test("HostedWorkspace.resume: makes a suspended workspace active", () => {
  const resumed = HostedWorkspace.create("edge-dns", "alice", T1).suspend(T1)
    .resume(T2);
  assertEquals(resumed.wanted, "active");
  assertEquals(resumed.changedAt, T2.toISOString());
});

Deno.test("HostedWorkspace.resume: an active workspace gets a new record, which takes it out of failed", () => {
  const active = HostedWorkspace.create("edge-dns", "alice", T1);
  const resumed = active.resume(T2);
  assertEquals(resumed.wanted, "active");
  assertEquals(resumed.changedAt, T2.toISOString());
  assert(!resumed.equals(active));
});

Deno.test("HostedWorkspace.markDeleted: deleted is never left", () => {
  const deleted = HostedWorkspace.active("edge-dns").markDeleted(T1);
  assertEquals(deleted.wanted, "deleted");
  assert(deleted.markDeleted(T2).equals(deleted));
  assertThrows(() => deleted.resume(T2), UserError, "being deleted");
  assertThrows(() => deleted.suspend(T2), UserError, "being deleted");
});

Deno.test("serveWantedOf: active is the supervisor's running, and hostedWantedOf maps it back", () => {
  assertEquals(serveWantedOf("active"), "running");
  assertEquals(serveWantedOf("suspended"), "suspended");
  assertEquals(serveWantedOf("deleted"), "deleted");
  assertEquals(hostedWantedOf("running"), "active");
  assertEquals(
    HostedWorkspace.active("edge-dns").suspend(T1).toServeWanted(),
    "suspended",
  );
});

Deno.test("serveWantedOfRecord: no record is not started, and a record maps as its wanted state does", () => {
  assertEquals(serveWantedOfRecord(null), "suspended");
  const active = HostedWorkspace.active("edge-dns");
  assertEquals(serveWantedOfRecord(active), "running");
  assertEquals(serveWantedOfRecord(active.suspend(T1)), "suspended");
  assertEquals(serveWantedOfRecord(active.markDeleted(T1)), "deleted");
});

Deno.test("HostedWorkspace.withFolder: the folder is kept through suspend, resume and delete, and is part of equals", () => {
  const plain = HostedWorkspace.create("edge-dns", "alice", T1);
  const named = plain.withFolder("/srv/repos/edge-dns");
  assertEquals(named.folder, "/srv/repos/edge-dns");
  assertEquals(plain.folder, null);
  assert(!named.equals(plain));
  assertEquals(named.suspend(T2).folder, "/srv/repos/edge-dns");
  assertEquals(named.suspend(T2).resume(T3).folder, "/srv/repos/edge-dns");
  assertEquals(named.markDeleted(T2).folder, "/srv/repos/edge-dns");
  assert(named.withFolder(null).equals(plain));
  assertEquals(named.withFolder(null).toRecord(), plain.toRecord());
  assertThrows(() => plain.withFolder(""), UserError);
});

Deno.test("HostedWorkspace.fromRecord: a record with no folder or a null folder is a workspace in workspaces/", () => {
  const record = {
    name: "edge-dns",
    creator: null,
    wanted: "active" as const,
    changedAt: null,
  };
  assertEquals(HostedWorkspace.fromRecord(record).folder, null);
  assertEquals(
    HostedWorkspace.fromRecord({ ...record, folder: null }).toRecord(),
    record,
  );
  assertThrows(
    () => HostedWorkspace.fromRecord({ ...record, folder: "" }),
    UserError,
  );
});

Deno.test("HostedWorkspace.withRepoId: the repoId is kept through suspend, resume and delete, and is part of equals", () => {
  const plain = HostedWorkspace.create("edge-dns", "alice", T1)
    .withFolder("/srv/repos/edge-dns");
  const made = plain.withRepoId("repo-1");
  assertEquals(made.repoId, "repo-1");
  assertEquals(plain.repoId, null);
  assert(!made.equals(plain));
  assert(!made.equals(plain.withRepoId("repo-2")));
  assertEquals(made.suspend(T2).repoId, "repo-1");
  assertEquals(made.suspend(T2).resume(T3).repoId, "repo-1");
  assertEquals(made.markDeleted(T2).repoId, "repo-1");
  assert(made.withRepoId(null).equals(plain));
  assertEquals(made.withRepoId(null).toRecord(), plain.toRecord());
  assertThrows(() => plain.withRepoId(""), UserError);
});

Deno.test("HostedWorkspace.fromRecord: a record with no repoId or a null repoId has none, and an empty one is refused", () => {
  const record = {
    name: "edge-dns",
    creator: "alice",
    wanted: "active" as const,
    changedAt: null,
    folder: "/srv/repos/edge-dns",
  };
  assertEquals(HostedWorkspace.fromRecord(record).repoId, null);
  assertEquals(
    HostedWorkspace.fromRecord({ ...record, repoId: null }).toRecord(),
    record,
  );
  assertEquals(
    HostedWorkspace.fromRecord({ ...record, repoId: "repo-1" }).repoId,
    "repo-1",
  );
  assertThrows(
    () => HostedWorkspace.fromRecord({ ...record, repoId: "" }),
    UserError,
  );
});
