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
import type { DataRecord } from "../../domain/data/data_record.ts";
import {
  integrationList,
  type IntegrationListData,
} from "./integration_list.ts";
import type { LibSwampContext } from "../context.ts";

const HASH = `sha256:${"a".repeat(64)}`;

function record(id: string, attributes: Record<string, unknown> = {}) {
  return {
    attributes: {
      id,
      name: id,
      credentialHash: HASH,
      ceiling: { version: 1, ceiling: [] },
      ceilingDigest: "sha256:x",
      state: "active",
      createdAt: new Date(0).toISOString(),
      ...attributes,
    },
  } as unknown as DataRecord;
}

async function list(records: DataRecord[]): Promise<IntegrationListData> {
  for await (
    const event of integrationList({} as LibSwampContext, {
      query: () => Promise.resolve(records),
    })
  ) {
    if (event.kind === "completed") return event.data;
    if (event.kind === "error") throw new Error(event.error.message);
  }
  throw new Error("no result");
}

Deno.test("integrationList: never shows the credential's hash, and keeps revoked ids", async () => {
  const data = await list([
    record("b", { state: "revoked" }),
    record("a"),
  ]);
  assertEquals(data.integrations.map((v) => [v.id, v.state]), [
    ["a", "active"],
    ["b", "revoked"],
  ]);
  assertEquals(JSON.stringify(data).includes(HASH), false);
  assertEquals(JSON.stringify(data).includes("credentialHash"), false);
});

Deno.test("integrationList: keeps a record whose ceiling this build can't read, so it can be seen and revoked", async () => {
  const data = await list([
    record("a", { ceiling: { version: 9, ceiling: [] } }),
  ]);
  assertEquals(data.count, 1);
});

Deno.test("integrationList: shows a record serve refuses, as unreadable", async () => {
  const data = await list([record("a", { state: "future-state" })]);
  assertEquals(data.integrations.map((v) => [v.id, v.state]), [
    ["a", "unreadable"],
  ]);
});
