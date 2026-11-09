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
import type { UnifiedDataRepository } from "../data/repositories.ts";
import { endDelegation, issueDelegationTokens } from "./delegation.ts";
import {
  DelegationDirectory,
  type DelegationEnded,
} from "./delegation_directory.ts";
import { consentedRecord, T0 } from "./delegation_test_helpers.ts";

interface Row {
  readonly modelId: string;
  attrs?: unknown;
}

function repo(state: { rows: Row[]; fail?: boolean }): UnifiedDataRepository {
  return {
    findAllForType: (type: { normalized: string }) => {
      if (state.fail) return Promise.reject(new Error("listing failed"));
      if (type.normalized.startsWith("@")) return Promise.resolve([]);
      return Promise.resolve(state.rows.map((row) => ({
        data: { name: "delegation-main" },
        modelType: type,
        modelId: row.modelId,
      })));
    },
    getContent: (_type: unknown, modelId: string) => {
      const row = state.rows.find((r) => r.modelId === modelId)!;
      return Promise.resolve(
        new TextEncoder().encode(JSON.stringify(row.attrs)),
      );
    },
  } as unknown as UnifiedDataRepository;
}

async function issued(options: { userId?: string; atMs?: number } = {}) {
  return (await issueDelegationTokens(consentedRecord(options), T0)).record;
}

Deno.test("DelegationDirectory: every delegation is unknown before the first load and after a failed one", async () => {
  const record = await issued();
  const state = { rows: [{ modelId: "1", attrs: record }], fail: true };
  const directory = new DelegationDirectory(repo(state), {
    now: () => T0,
    retryMs: 60_000,
  });
  assertEquals(directory.standingOf(record.id).kind, "unknown");
  await directory.reload();
  assertEquals(directory.standingOf(record.id).kind, "unknown");
  state.fail = false;
  await directory.reload();
  assertEquals(directory.standingOf(record.id).kind, "standing");
  await directory.dispose();
});

Deno.test("DelegationDirectory: an ended copy wins over a live one", async () => {
  const record = await issued();
  const directory = new DelegationDirectory(
    repo({
      rows: [
        { modelId: "1", attrs: endDelegation(record, "operator", T0) },
        { modelId: "2", attrs: record },
      ],
    }),
    { now: () => T0 },
  );
  await directory.reload();
  assertEquals(directory.standingOf(record.id).kind, "ended");
  await directory.dispose();
});

Deno.test("DelegationDirectory: a newer consent for the same person supersedes the older", async () => {
  const older = await issued({ atMs: T0 - 1000 });
  const newer = await issued({ atMs: T0 });
  const directory = new DelegationDirectory(
    repo({
      rows: [{ modelId: "1", attrs: older }, { modelId: "2", attrs: newer }],
    }),
    { now: () => T0 },
  );
  await directory.reload();
  assertEquals(directory.standingOf(older.id).kind, "superseded");
  assertEquals(directory.standingOf(newer.id).kind, "standing");
  await directory.dispose();
});

Deno.test("DelegationDirectory: an invalid record refuses only its own delegation", async () => {
  const good = await issued({ userId: "U2" });
  const bad = await issued();
  const directory = new DelegationDirectory(
    repo({
      rows: [
        { modelId: "1", attrs: { ...bad, phase: "sideways" } },
        { modelId: "2", attrs: good },
      ],
    }),
    { now: () => T0 },
  );
  await directory.reload();
  assertEquals(directory.standingOf(bad.id).kind, "unreadable");
  assertEquals(directory.standingOf(good.id).kind, "standing");
  await directory.dispose();
});

Deno.test("DelegationDirectory: onEnded names delegations that lost standing in a reload", async () => {
  const record = await issued();
  const row: Row = { modelId: "1", attrs: record };
  const directory = new DelegationDirectory(repo({ rows: [row] }), {
    now: () => T0,
  });
  const seen: DelegationEnded[] = [];
  directory.onEnded((ended) => seen.push(...ended));
  await directory.reload();
  assertEquals(seen, []);
  row.attrs = endDelegation(record, "operator", T0);
  await directory.reload();
  assertEquals(seen, [{ id: record.id, integrationId: "slack-bot" }]);
  await directory.dispose();
});
