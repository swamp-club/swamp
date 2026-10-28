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

import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import {
  InboxCacheKey,
  InboxState,
  isStorableEtag,
  MAX_ETAG_LENGTH,
} from "./inbox_state.ts";

Deno.test("InboxState.empty: has no snapshot, schedule or announcement", () => {
  assertEquals(InboxState.empty(), {
    snapshot: null,
    schedule: { lastPolledAt: null, nextPollAt: null, stop: null },
    announcement: null,
  });
});

Deno.test("InboxState.empty: returns a fresh value each call", () => {
  const a = InboxState.empty();
  const b = InboxState.empty();
  assertEquals(a, b);
  assertEquals(a === b, false);
});

Deno.test("isStorableEtag: accepts quoted and weak validators", () => {
  assertEquals(isStorableEtag('"abc123"'), true);
  assertEquals(isStorableEtag('W/"abc123"'), true);
  assertEquals(isStorableEtag("x".repeat(MAX_ETAG_LENGTH)), true);
});

Deno.test("isStorableEtag: refuses empty, over-long and non-printable values", () => {
  assertEquals(isStorableEtag(""), false);
  assertEquals(isStorableEtag("x".repeat(MAX_ETAG_LENGTH + 1)), false);
  assertEquals(isStorableEtag('"a\nb"'), false);
  assertEquals(isStorableEtag('"aé"'), false);
});

Deno.test("InboxCacheKey.of: keys by the server's origin, whatever its path or case", () => {
  const fingerprint = "0123456789abcdef";
  const key = InboxCacheKey.of("https://Swamp-Club.com/api/", fingerprint);
  assertEquals(key, { origin: "https://swamp-club.com", fingerprint });
  assertEquals(
    InboxCacheKey.of("https://swamp-club.com", fingerprint),
    key,
  );
  assertNotEquals(
    InboxCacheKey.of("https://staging.swamp-club.com", fingerprint),
    key,
  );
});

Deno.test("InboxCacheKey.of: throws on a server URL that does not parse", () => {
  assertThrows(() => InboxCacheKey.of("not a url", "0123456789abcdef"));
});
