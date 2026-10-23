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

import { assertEquals, assertStrictEquals } from "@std/assert";
import {
  type ApprovalsReply,
  expiredApprovals,
  pendingApprovals,
} from "./approvals.ts";
import { createApprovalsRequest } from "./approvals_request.ts";
import { loadState } from "./load_state.ts";
import { RequestError } from "./stream.ts";

const gate = { workflowName: "deploy", runId: "run", stepName: "gate" };
const pending: ApprovalsReply = { data: { approvals: [gate], expired: [] } };
const empty: ApprovalsReply = { data: { approvals: [], expired: [] } };

function controlled() {
  const replies: PromiseWithResolvers<ApprovalsReply>[] = [];
  const owner = createApprovalsRequest(() => {
    const reply = Promise.withResolvers<ApprovalsReply>();
    replies.push(reply);
    return reply.promise;
  });
  return { owner, replies };
}

Deno.test("createApprovalsRequest: two consumers share the initial read and snapshot", async () => {
  const { owner, replies } = controlled();
  const badges: number[] = [];
  const pages: number[] = [];
  const unsubscribeBadge = owner.subscribe(() =>
    badges.push(pendingApprovals(owner.getSnapshot().data).length)
  );
  const unsubscribePage = owner.subscribe(() =>
    pages.push(pendingApprovals(owner.getSnapshot().data).length)
  );
  assertEquals(loadState(owner.getSnapshot()), "loading");
  // Child effects can run before the owner starts. They must not send reads.
  assertEquals(await owner.reload(), null);
  const initial = owner.start();
  const joined = owner.reload();
  assertEquals(replies.length, 1);
  replies[0].resolve(pending);
  assertStrictEquals(await initial, pending);
  assertStrictEquals(await joined, pending);
  assertEquals(badges, [0, 1]);
  assertEquals(pages, badges);
  assertEquals(loadState(owner.getSnapshot()), "ready");
  unsubscribePage();
  unsubscribeBadge();
  owner.stop();
  assertEquals(pages, [0, 1]);
});

Deno.test("createApprovalsRequest: simultaneous reloads after settling send one new read", async () => {
  const { owner, replies } = controlled();
  const initial = owner.start();
  replies[0].resolve(pending);
  await initial;
  const one = owner.reload();
  const two = owner.reload();
  assertEquals(replies.length, 2);
  assertEquals(owner.getSnapshot().loading, true);
  assertStrictEquals(owner.getSnapshot().data, pending);
  replies[1].resolve(empty);
  assertStrictEquals(await one, empty);
  assertStrictEquals(await two, empty);
  assertEquals(pendingApprovals(owner.getSnapshot().data), []);
  owner.stop();
});

Deno.test("createApprovalsRequest: initial denial preserves error info and permits retry", async () => {
  const { owner, replies } = controlled();
  const initial = owner.start();
  replies[0].reject(new RequestError("Denied", "unauthorized"));
  assertEquals(await initial, null);
  assertEquals(owner.getSnapshot(), {
    data: null,
    loading: false,
    error: "Denied",
    errorInfo: { code: "unauthorized" },
  });
  assertEquals(loadState(owner.getSnapshot()), "error");
  const retry = owner.reload();
  assertEquals(owner.getSnapshot().errorInfo, null);
  replies[1].resolve(empty);
  await retry;
  assertEquals(
    loadState(owner.getSnapshot(), (d) => pendingApprovals(d).length === 0),
    "empty",
  );
  owner.stop();
});

Deno.test("createApprovalsRequest: failed background refresh retains data but returns no fresh reply", async () => {
  const { owner, replies } = controlled();
  const initial = owner.start();
  replies[0].resolve(pending);
  await initial;
  const fresh = owner.refresh();
  replies[1].reject(new Error("Offline"));
  assertEquals(await fresh, null);
  assertStrictEquals(owner.getSnapshot().data, pending);
  assertEquals(owner.getSnapshot().loading, false);
  assertEquals(owner.getSnapshot().error, "Offline");
  assertEquals(loadState(owner.getSnapshot()), "ready");
  const retry = owner.reload();
  replies[2].resolve(empty);
  await retry;
  assertEquals(owner.getSnapshot().error, null);
  owner.stop();
});

Deno.test("createApprovalsRequest: mutation supersedes an in-flight read in either reply order", async () => {
  for (const oldFirst of [true, false]) {
    const { owner, replies } = controlled();
    const old = owner.start();
    const fresh = owner.refresh();
    const joined = owner.reload();
    assertEquals(replies.length, 2);
    if (oldFirst) {
      replies[0].resolve(pending);
      assertEquals(await old, null);
      assertEquals(owner.getSnapshot().data, null);
      replies[1].resolve(empty);
    } else {
      replies[1].resolve(empty);
      await fresh;
      replies[0].resolve(pending);
    }
    assertEquals(await old, null);
    assertStrictEquals(await fresh, empty);
    assertStrictEquals(await joined, empty);
    assertStrictEquals(owner.getSnapshot().data, empty);
    owner.stop();
  }
});

Deno.test("createApprovalsRequest: successive completed mutations each retire the previous read", async () => {
  const { owner, replies } = controlled();
  const first = owner.start();
  const decision = owner.refresh();
  const cancellation = owner.refresh();
  assertEquals(replies.length, 3);
  replies[2].resolve(empty);
  await cancellation;
  replies[1].reject(new Error("An older read failed"));
  replies[0].resolve(pending);
  assertEquals(await Promise.all([first, decision]), [null, null]);
  assertEquals(owner.getSnapshot().error, null);
  assertStrictEquals(owner.getSnapshot().data, empty);
  owner.stop();
});

Deno.test("createApprovalsRequest: refused decision reconciliation returns the same result the badge reads", async () => {
  const { owner, replies } = controlled();
  const initial = owner.start();
  replies[0].resolve(pending);
  await initial;
  const reconciliation = owner.refresh();
  replies[1].resolve(empty);
  const fresh = await reconciliation;
  assertStrictEquals(fresh, owner.getSnapshot().data);
  assertEquals(
    pendingApprovals(fresh).some((a) => a.runId === gate.runId),
    false,
  );
  assertEquals(replies.length, 2);
  owner.stop();
});

Deno.test("createApprovalsRequest: refresh moves expired gates out of every consumer's pending list", async () => {
  const { owner, replies } = controlled();
  const initial = owner.start();
  replies[0].resolve(pending);
  await initial;
  const expired = {
    ...gate,
    workflowId: "workflow",
    suspendedAt: "2026-10-23T00:00:00Z",
    timeoutSeconds: 60,
    expiredAt: "2026-10-23T00:01:00Z",
  };
  const reload = owner.reload();
  replies[1].resolve({ data: { approvals: [], expired: [expired] } });
  await reload;
  assertEquals(pendingApprovals(owner.getSnapshot().data), []);
  assertEquals(expiredApprovals(owner.getSnapshot().data), [expired]);
  owner.stop();
});

Deno.test("createApprovalsRequest: stop clears data and prevents late mutation callbacks sending reads", async () => {
  const { owner, replies } = controlled();
  const initial = owner.start();
  replies[0].resolve(pending);
  await initial;
  const old = owner.reload();
  owner.stop();
  assertEquals(await owner.refresh(), null);
  assertEquals(await owner.reload(), null);
  replies[1].resolve(pending);
  assertEquals(await old, null);
  assertEquals(owner.getSnapshot().data, null);
  assertEquals(replies.length, 2);
});

Deno.test("createApprovalsRequest: effect cleanup and restart cannot apply the previous lifetime's reply", async () => {
  const { owner, replies } = controlled();
  const old = owner.start();
  owner.stop();
  const restarted = owner.start();
  const joined = owner.reload();
  replies[0].resolve(pending);
  assertEquals(await old, null);
  assertEquals(owner.getSnapshot().data, null);
  replies[1].resolve(empty);
  assertStrictEquals(await restarted, empty);
  assertStrictEquals(await joined, empty);
  owner.stop();
});

Deno.test("createApprovalsRequest: a synchronous transport error does not wedge future reads", async () => {
  let fail = true;
  const owner = createApprovalsRequest(() => {
    if (fail) throw new Error("Disconnected");
    return Promise.resolve(empty);
  });
  assertEquals(await owner.start(), null);
  fail = false;
  assertStrictEquals(await owner.reload(), empty);
  owner.stop();
});
