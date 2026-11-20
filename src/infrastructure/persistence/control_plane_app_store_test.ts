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
import { FileSystemControlPlaneStore } from "./fs_control_plane_store.ts";
import { ControlPlaneAppApprovalRepository } from "./control_plane_app_store.ts";

async function withStore(
  body: (store: FileSystemControlPlaneStore) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await body(new FileSystemControlPlaneStore(dir));
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

const approval = {
  name: "@acme/cost",
  capabilityKey: "key",
  approvedBy: "user:a",
  approvedAt: "2026-11-04T00:00:00.000Z",
};

Deno.test("ControlPlaneAppApprovalRepository: a second instance sees an approval at once", async () => {
  await withStore(async (store) => {
    await new ControlPlaneAppApprovalRepository(store).save(approval);
    assertEquals(
      await new ControlPlaneAppApprovalRepository(store).get("@acme/cost"),
      approval,
    );
  });
});

Deno.test("ControlPlaneAppApprovalRepository: delete says whether one existed", async () => {
  await withStore(async (store) => {
    const repository = new ControlPlaneAppApprovalRepository(store);
    assertEquals(await repository.delete("@acme/cost"), false);
    await repository.save(approval);
    assertEquals(await repository.delete("@acme/cost"), true);
    assertEquals(await repository.get("@acme/cost"), null);
  });
});

Deno.test("ControlPlaneAppApprovalRepository: an unreadable record approves nothing", async () => {
  await withStore(async (store) => {
    const repository = new ControlPlaneAppApprovalRepository(store);
    await repository.save(approval);
    const [key] = await store.list("app-approvals");
    await store.put(key, new TextEncoder().encode("{not json"));
    assertEquals(await repository.get("@acme/cost"), null);
  });
});
