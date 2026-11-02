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
import fc from "fast-check";
import type { AccountNotice } from "../../domain/account_notices/account_notice.ts";
import { MAX_ACCOUNT_NOTICES } from "../../domain/account_notices/account_notice.ts";
import type { AccountNoticeState } from "../../domain/account_notices/account_notice_state.ts";
import { POLL_STOP_REASONS } from "../../domain/inbox/inbox_state.ts";
import { AccountNoticeCacheFileRepository } from "./account_notice_cache_file_repository.ts";

const KEY = {
  origin: "https://swamp-club.com",
  fingerprint: "0123456789abcdef",
};
const time = fc.integer({ min: 0, max: Date.UTC(2100, 0, 1) });
const slug = fc.stringMatching(/^[a-z0-9_-]{1,20}$/);
// names as the parser leaves them: single spaces, none at either end
const name = fc.stringMatching(/^[A-Za-z0-9]{1,10}( [A-Za-z0-9]{1,10}){0,3}$/);
const billingPath = fc.constantFrom(null, "/billing", "/o/acme/billing");

const notice: fc.Arbitrary<AccountNotice> = fc.oneof(
  fc.record({ slug, name, personal: fc.boolean(), billingPath }).map((n) => ({
    kind: "trial-ended" as const,
    collective: { slug: n.slug, name: n.name, personal: n.personal },
    billingPath: n.billingPath,
  })),
  fc.record({
    slug,
    name,
    personal: fc.boolean(),
    billingPath,
    endsAt: time,
    daysRemaining: fc.integer({ min: 0, max: 30 }),
  }).map((n) => ({
    kind: "trial-ending" as const,
    collective: { slug: n.slug, name: n.name, personal: n.personal },
    billingPath: n.billingPath,
    endsAt: n.endsAt,
    daysRemaining: n.daysRemaining,
  })),
);

const state: fc.Arbitrary<AccountNoticeState> = fc.record({
  snapshot: fc.option(
    fc.record({
      notices: fc.array(notice, { maxLength: MAX_ACCOUNT_NOTICES }),
      fetchedAt: time,
    }),
    { nil: null },
  ),
  schedule: fc.record({
    lastPolledAt: fc.option(time, { nil: null }),
    nextPollAt: fc.option(time, { nil: null }),
    stop: fc.option(
      fc.record({ reason: fc.constantFrom(...POLL_STOP_REASONS), at: time }),
      { nil: null },
    ),
  }),
  shown: fc.dictionary(
    fc.tuple(fc.constantFrom("trial-ended", "trial-ending"), slug).map((
      [k, s],
    ) => `${k}:${s}`),
    time,
    { maxKeys: 10 },
  ),
});

Deno.test("property: whatever the cache saves, it loads back unchanged", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-notice-cache-prop-" });
  try {
    const repo = new AccountNoticeCacheFileRepository(dir);
    await fc.assert(
      fc.asyncProperty(state, async (s) => {
        await repo.save(KEY, s);
        assertEquals(await repo.load(KEY), s);
      }),
      { numRuns: 100 },
    );
  } finally {
    const cleanup = Deno.remove(dir, { recursive: true });
    await (Deno.build.os === "windows" ? cleanup.catch(() => {}) : cleanup);
  }
});
