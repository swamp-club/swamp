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

import { assert, assertEquals } from "@std/assert";
import type { AuthCredentials } from "../../domain/auth/auth_credentials.ts";
import { AccountNoticeState } from "../../domain/account_notices/account_notice_state.ts";
import type { InboxCacheKey } from "../../domain/inbox/inbox_state.ts";
import type { AccountNoticesResult } from "../../infrastructure/http/account_notice_schemas.ts";
import {
  ACCOUNT_NOTICE_FAST_POLL_GRACE_MS,
  ACCOUNT_NOTICE_POLL_GRACE_MS,
  type AccountNoticeDeps,
  refreshAccountNotices,
  showAccountNotice,
  startAccountNoticePoll,
} from "./notice.ts";

const credentials: AuthCredentials = {
  serverUrl: "https://swamp-club.com",
  apiKey: "swamp_test_key",
  apiKeyId: "key-1",
  username: "keeb",
};

const NOW = Date.parse("2026-11-02T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

const endedResult: AccountNoticesResult = {
  kind: "ok",
  notices: [{
    kind: "trial-ended",
    slug: "keeb",
    name: "keeb",
    personal: true,
    href: "/billing",
  }],
};

const endingResult: AccountNoticesResult = {
  kind: "ok",
  notices: [{
    kind: "trial-ending",
    slug: "acme",
    name: "Acme",
    personal: false,
    href: null,
    endsAt: new Date(NOW + 5 * DAY_MS).toISOString(),
    daysRemaining: 5,
  }],
};

interface Harness {
  deps: AccountNoticeDeps;
  saved: AccountNoticeState[];
  requests: number;
  setNow(ms: number): void;
  state(): AccountNoticeState;
}

function harness(
  options: {
    result?: AccountNoticesResult | Promise<AccountNoticesResult>;
    credentials?: AuthCredentials | null;
    writable?: boolean;
    state?: AccountNoticeState;
    saveFails?: boolean;
  } = {},
): Harness {
  let now = NOW;
  let stored = options.state ?? AccountNoticeState.empty();
  const saved: AccountNoticeState[] = [];
  const h: Harness = {
    saved,
    requests: 0,
    setNow: (ms) => {
      now = ms;
    },
    state: () => stored,
    deps: {
      loadCredentials: () =>
        Promise.resolve(
          options.credentials === undefined ? credentials : options.credentials,
        ),
      accountNotices: (_url, _key, signal) => {
        h.requests++;
        const result = options.result ?? endedResult;
        return result instanceof Promise
          ? Promise.race([
            result,
            new Promise<AccountNoticesResult>((resolve) =>
              signal.addEventListener("abort", () =>
                resolve({ kind: "failed", reason: "timeout" }))
            ),
          ])
          : Promise.resolve(result);
      },
      loadState: (_key: InboxCacheKey) => Promise.resolve(stored),
      saveState: (_key, state) => {
        if (options.saveFails) return Promise.reject(new Error("disk full"));
        stored = state;
        saved.push(state);
        return Promise.resolve();
      },
      configDirWritable: () => Promise.resolve(options.writable ?? true),
      now: () => now,
      wait: () => Promise.resolve(),
    },
  };
  return h;
}

Deno.test("startAccountNoticePoll: a slow command polls and saves the answer at settle", async () => {
  const h = harness();
  const poll = await startAccountNoticePoll(h.deps, { slowCommand: true });
  assert(poll);
  await poll.settle();
  assertEquals(h.requests, 1);
  assertEquals(h.state().snapshot?.notices[0].kind, "trial-ended");
  assertEquals(h.state().snapshot?.notices[0].billingPath, "/billing");
});

Deno.test("startAccountNoticePoll: a fast command with nothing ended cached does not poll", async () => {
  const h = harness();
  assertEquals(
    await startAccountNoticePoll(h.deps, { slowCommand: false }),
    null,
  );
  assertEquals(h.requests, 0);
});

Deno.test("startAccountNoticePoll: a fast command polls once an ended trial is cached", async () => {
  const h = harness();
  await (await startAccountNoticePoll(h.deps, { slowCommand: true }))!.settle();
  h.setNow(NOW + 15 * 60 * 1000);
  const poll = await startAccountNoticePoll(h.deps, { slowCommand: false });
  assert(poll);
  await poll.settle();
  assertEquals(h.requests, 2);
});

Deno.test("startAccountNoticePoll: no key, or a cache it cannot write, means no poll", async () => {
  const noKey = harness({ credentials: null });
  assertEquals(
    await startAccountNoticePoll(noKey.deps, { slowCommand: true }),
    null,
  );
  const readOnly = harness({ writable: false });
  assertEquals(
    await startAccountNoticePoll(readOnly.deps, { slowCommand: true }),
    null,
  );
  assertEquals(noKey.requests + readOnly.requests, 0);
});

Deno.test("startAccountNoticePoll: a poll still running at settle is aborted and saved as failed", async () => {
  const h = harness({ result: new Promise(() => {}) });
  const poll = await startAccountNoticePoll(h.deps, { slowCommand: true });
  await poll!.settle();
  assertEquals(h.state().snapshot, null);
  assertEquals(h.state().schedule.lastPolledAt, NOW);
});

Deno.test("startAccountNoticePoll: a collective key stops polling", async () => {
  const h = harness({ result: { kind: "unavailable" } });
  await (await startAccountNoticePoll(h.deps, { slowCommand: true }))!.settle();
  assertEquals(h.state().schedule.stop?.reason, "unavailable");
  h.setNow(NOW + 30 * DAY_MS);
  assertEquals(
    await startAccountNoticePoll(h.deps, { slowCommand: true }),
    null,
  );
});

Deno.test("showAccountNotice: shows a cached notice once, records it, then holds it for a day", async () => {
  const h = harness();
  await (await startAccountNoticePoll(h.deps, { slowCommand: true }))!.settle();
  assertEquals(await showAccountNotice(h.deps), {
    kind: "trial-ended",
    slug: "keeb",
    name: "keeb",
    personal: true,
    billingUrl: "https://swamp-club.com/billing",
  });
  assertEquals(await showAccountNotice(h.deps), null);
  h.setNow(NOW + DAY_MS);
  assertEquals((await showAccountNotice(h.deps))?.kind, "trial-ended");
});

Deno.test("showAccountNotice: an ending trial counts its days at display time and falls back to swamp's billing URL", async () => {
  const h = harness({ result: endingResult });
  await (await startAccountNoticePoll(h.deps, { slowCommand: true }))!.settle();
  h.setNow(NOW + 2 * DAY_MS);
  assertEquals(await showAccountNotice(h.deps), {
    kind: "trial-ending",
    slug: "acme",
    name: "Acme",
    personal: false,
    billingUrl: "https://swamp-club.com/o/acme/billing",
    endsAt: new Date(NOW + 5 * DAY_MS).toISOString(),
    daysRemaining: 3,
  });
});

Deno.test("showAccountNotice: flips to ended at endsAt with no network call", async () => {
  const h = harness({ result: endingResult });
  await (await startAccountNoticePoll(h.deps, { slowCommand: true }))!.settle();
  await showAccountNotice(h.deps);
  h.setNow(NOW + 5 * DAY_MS);
  const requests = h.requests;
  assertEquals((await showAccountNotice(h.deps))?.kind, "trial-ended");
  assertEquals(h.requests, requests);
});

Deno.test("showAccountNotice: prints nothing it could not record", async () => {
  const h = harness();
  await (await startAccountNoticePoll(h.deps, { slowCommand: true }))!.settle();
  const readOnly = harness({ writable: false, state: h.state() });
  assertEquals(await showAccountNotice(readOnly.deps), null);
  const failing = harness({ saveFails: true, state: h.state() });
  assertEquals(await showAccountNotice(failing.deps), null);
});

Deno.test("refreshAccountNotices: fetches now, saves, and returns the views", async () => {
  const h = harness({ result: endingResult });
  const views = await refreshAccountNotices(h.deps);
  assertEquals(views?.map((v) => [v.kind, v.daysRemaining]), [[
    "trial-ending",
    5,
  ]]);
  assertEquals(h.saved.length, 1);
});

Deno.test("refreshAccountNotices: a failure is null, never an empty list", async () => {
  const failed = harness({ result: { kind: "failed", reason: "HTTP 502" } });
  assertEquals(await refreshAccountNotices(failed.deps), null);
  const noKey = harness({ credentials: null });
  assertEquals(await refreshAccountNotices(noKey.deps), null);
});

Deno.test("refreshAccountNotices: still returns the notices when it cannot save them", async () => {
  const h = harness({ writable: false });
  assertEquals((await refreshAccountNotices(h.deps))?.length, 1);
  assertEquals(h.saved.length, 0);
});

Deno.test("startAccountNoticePoll: a fast command waits longer for its poll than a slow one", async () => {
  const waits: number[] = [];
  const h = harness();
  h.deps.wait = (ms) => {
    waits.push(ms);
    return Promise.resolve();
  };
  await (await startAccountNoticePoll(h.deps, { slowCommand: true }))!.settle();
  h.setNow(NOW + 15 * 60 * 1000);
  await (await startAccountNoticePoll(h.deps, { slowCommand: false }))!
    .settle();
  assertEquals(waits, [
    ACCOUNT_NOTICE_POLL_GRACE_MS,
    ACCOUNT_NOTICE_FAST_POLL_GRACE_MS,
  ]);
});

Deno.test("startAccountNoticePoll: the poll counts before it is sent, so a run that never settles can't repeat it", async () => {
  const h = harness({ result: new Promise(() => {}) });
  const poll = await startAccountNoticePoll(h.deps, { slowCommand: true });
  assert(poll);
  // never settled, as when the command calls Deno.exit
  assertEquals(h.state().schedule.lastPolledAt, NOW);
  h.setNow(NOW + 60 * 1000);
  assertEquals(
    await startAccountNoticePoll(h.deps, { slowCommand: true }),
    null,
  );
  assertEquals(h.requests, 1);
});

Deno.test("startAccountNoticePoll: a cache it cannot record the attempt in means no poll", async () => {
  const h = harness({ saveFails: true });
  assertEquals(
    await startAccountNoticePoll(h.deps, { slowCommand: true }),
    null,
  );
  assertEquals(h.requests, 0);
});
