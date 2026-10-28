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

import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import {
  type AuthCredentials,
  keyFingerprint,
} from "../../domain/auth/auth_credentials.ts";
import { UserError } from "../../domain/errors.ts";
import { InboxCacheKey, InboxState } from "../../domain/inbox/inbox_state.ts";
import {
  type InboxListOptions,
  type InboxMessagePage,
  type InboxSummaryResult,
  parseInboxMessagePage,
} from "../../infrastructure/http/inbox_schemas.ts";
import { createLibSwampContext } from "../context.ts";
import { collect } from "../testing.ts";
import {
  type InboxReadDeps,
  inboxReadNext,
  type InboxReadNextEvent,
  markRead,
  type MarkReadEvent,
  MAX_INBOX_READ_PAGES,
} from "./read.ts";

const fixture = JSON.parse(
  await Deno.readTextFile(
    new URL(
      "../../infrastructure/http/inbox_responses.fixture.json",
      import.meta.url,
    ),
  ),
);
const fullPage: InboxMessagePage = parseInboxMessagePage(
  fixture.messagesPage,
)!;
const unreadPage: InboxMessagePage = {
  messages: fullPage.messages.filter((m) => m.readAt === null),
  nextCursor: null,
  dropped: 0,
};

const credentials: AuthCredentials = {
  serverUrl: "https://swamp-club.com",
  apiKey: "swamp_test_key",
  apiKeyId: "key-1",
  username: "keeb",
};

const NOW = Date.parse("2026-10-27T12:00:00.000Z");

const okSummary: InboxSummaryResult = {
  kind: "ok",
  summary: {
    unread: 1,
    newestId: "01JBX5Q8ZK00000000000000ZX",
    newestAt: "2026-10-25T17:30:00.000Z",
    pollAfterSeconds: 900,
  },
  etag: '"v2"',
};

interface Recorder {
  listed: InboxListOptions[];
  marked: string[][];
  summaries: number;
  saved: { key: InboxCacheKey; state: InboxState }[];
}

function makeDeps(overrides: Partial<InboxReadDeps> & {
  page?: InboxMessagePage;
  summary?: InboxSummaryResult;
  credentials?: AuthCredentials | null;
} = {}): { deps: InboxReadDeps; rec: Recorder } {
  const rec: Recorder = { listed: [], marked: [], summaries: 0, saved: [] };
  const deps: InboxReadDeps = {
    loadCredentials: () =>
      Promise.resolve(
        overrides.credentials === undefined
          ? credentials
          : overrides.credentials,
      ),
    listMessages: (_url, _key, options) => {
      rec.listed.push(options);
      return Promise.resolve(overrides.page ?? unreadPage);
    },
    markInboxRead: (_url, _key, ids) => {
      rec.marked.push([...ids]);
      return Promise.resolve([...ids]);
    },
    inboxSummary: () => {
      rec.summaries++;
      return Promise.resolve(overrides.summary ?? okSummary);
    },
    loadInboxState: () => Promise.resolve(InboxState.empty()),
    saveInboxState: (key, state) => {
      rec.saved.push({ key, state });
      return Promise.resolve();
    },
    ownsConfigDir: () => true,
    now: () => NOW,
    ...overrides,
  };
  return { deps, rec };
}

function lastOf<E extends { kind: string }>(events: E[]): E {
  const last = events.at(-1);
  assert(last !== undefined);
  return last;
}

Deno.test("inboxReadNext: reads the newest unread message and marks only it", async () => {
  const { deps, rec } = makeDeps();

  const events = await collect<InboxReadNextEvent>(
    inboxReadNext(createLibSwampContext(), deps),
  );

  assertEquals(rec.listed, [{ status: "unread", limit: 2 }]);
  assertEquals(rec.marked, [["01JBX5Q8ZK0000000000000104"]]);
  const last = lastOf(events);
  assert(last.kind === "completed");
  assertEquals(last.view.message?.id, "01JBX5Q8ZK0000000000000104");
  assertEquals(last.view.message?.body, unreadPage.messages[0].body);
  assertEquals(last.view.message?.link, unreadPage.messages[0].link);
  assertEquals(last.view.message?.readAt, new Date(NOW).toISOString());
  assertEquals(last.view.marked, true);
  assertEquals(last.view.moreUnread, true);
  assertEquals(last.view.dropped, 0);
});

Deno.test("inboxReadNext: moreUnread follows a second message or a cursor", async () => {
  const one = unreadPage.messages.slice(0, 1);
  const cases: [InboxMessagePage, boolean][] = [
    [{ messages: one, nextCursor: null, dropped: 0 }, false],
    [{ messages: one, nextCursor: one[0].id, dropped: 0 }, true],
    [unreadPage, true],
    // The second entry broke the contract: it is still an unread message.
    [{ messages: one, nextCursor: null, dropped: 1 }, true],
  ];
  for (const [page, expected] of cases) {
    const { deps } = makeDeps({ page });

    const last = lastOf(
      await collect<InboxReadNextEvent>(
        inboxReadNext(createLibSwampContext(), deps),
      ),
    );

    assert(last.kind === "completed");
    assertEquals(last.view.moreUnread, expected);
  }
});

Deno.test("inboxReadNext: nothing unread marks nothing and reports dropped", async () => {
  const { deps, rec } = makeDeps({
    page: { messages: [], nextCursor: null, dropped: 1 },
  });

  const last = lastOf(
    await collect<InboxReadNextEvent>(
      inboxReadNext(createLibSwampContext(), deps),
    ),
  );

  assert(last.kind === "completed");
  assertEquals(last.view, {
    message: null,
    marked: false,
    moreUnread: false,
    dropped: 1,
  });
  assertEquals(rec.marked, []);
  assertEquals(rec.summaries, 0);
});

Deno.test("inboxReadNext: pages past entries that were all dropped", async () => {
  const [valid] = unreadPage.messages;
  const pages: InboxMessagePage[] = [
    { messages: [], nextCursor: "01JBX5Q8ZK00000000000000Z1", dropped: 2 },
    { messages: [], nextCursor: "01JBX5Q8ZK00000000000000Z0", dropped: 2 },
    { messages: [valid], nextCursor: null, dropped: 0 },
  ];
  const { deps, rec } = makeDeps({
    listMessages: (_url, _key, options) => {
      rec.listed.push(options);
      return Promise.resolve(pages[rec.listed.length - 1]);
    },
  });

  const last = lastOf(
    await collect<InboxReadNextEvent>(
      inboxReadNext(createLibSwampContext(), deps),
    ),
  );

  assert(last.kind === "completed");
  assertEquals(last.view.message?.id, valid.id);
  assertEquals(last.view.dropped, 4);
  assertEquals(last.view.moreUnread, true);
  assertEquals(rec.marked, [[valid.id]]);
  assertEquals(rec.listed, [
    { status: "unread", limit: 2 },
    { status: "unread", limit: 2, before: "01JBX5Q8ZK00000000000000Z1" },
    { status: "unread", limit: 2, before: "01JBX5Q8ZK00000000000000Z0" },
  ]);
});

Deno.test("inboxReadNext: stops paging after MAX_INBOX_READ_PAGES pages of dropped entries", async () => {
  const { deps, rec } = makeDeps({
    page: {
      messages: [],
      nextCursor: "01JBX5Q8ZK00000000000000Z1",
      dropped: 2,
    },
  });

  const last = lastOf(
    await collect<InboxReadNextEvent>(
      inboxReadNext(createLibSwampContext(), deps),
    ),
  );

  assert(last.kind === "completed");
  assertEquals(last.view.message, null);
  assertEquals(rec.listed.length, MAX_INBOX_READ_PAGES);
  assertEquals(last.view.dropped, 2 * MAX_INBOX_READ_PAGES);
  // Older pages are left unlisted, so more unread messages remain.
  assertEquals(last.view.moreUnread, true);
  assertEquals(rec.marked, []);
});

Deno.test("inboxReadNext: an id swamp-club does not confirm stays unread", async () => {
  const { deps } = makeDeps({ markInboxRead: () => Promise.resolve([]) });

  const last = lastOf(
    await collect<InboxReadNextEvent>(
      inboxReadNext(createLibSwampContext(), deps),
    ),
  );

  assert(last.kind === "completed");
  assertEquals(last.view.marked, false);
  assertEquals(last.view.message?.readAt, null);
});

Deno.test("inboxReadNext: the refreshed summary goes into the key's cache", async () => {
  const { deps, rec } = makeDeps();

  await collect<InboxReadNextEvent>(
    inboxReadNext(createLibSwampContext(), deps),
  );

  assertEquals(rec.summaries, 1);
  assertEquals(rec.saved.length, 1);
  assertEquals(
    rec.saved[0].key,
    InboxCacheKey.of(
      credentials.serverUrl,
      await keyFingerprint(credentials.apiKey),
    ),
  );
  assertEquals(rec.saved[0].state.snapshot, {
    unread: 1,
    newestId: "01JBX5Q8ZK00000000000000ZX",
    newestAt: "2026-10-25T17:30:00.000Z",
    pollAfterSeconds: 900,
    etag: '"v2"',
    fetchedAt: NOW,
  });
  assertEquals(rec.saved[0].state.schedule.lastPolledAt, NOW);
});

Deno.test("inboxReadNext: the refresh is kept under the server it asked, not the stored one", async () => {
  const { deps, rec } = makeDeps({
    serverUrlOverride: "https://staging.swamp-club.com/",
  });

  await collect<InboxReadNextEvent>(
    inboxReadNext(createLibSwampContext(), deps),
  );

  assertEquals(rec.saved.length, 1);
  assertEquals(rec.saved[0].key.origin, "https://staging.swamp-club.com");
});

Deno.test("inboxReadNext: a failed refresh leaves the cache and still succeeds", async () => {
  const { deps, rec } = makeDeps({
    summary: { kind: "failed", reason: "timeout" },
  });

  const last = lastOf(
    await collect<InboxReadNextEvent>(
      inboxReadNext(createLibSwampContext(), deps),
    ),
  );

  assert(last.kind === "completed");
  assertEquals(last.view.marked, true);
  assertEquals(rec.saved, []);
});

Deno.test("inboxReadNext: a cache that cannot be saved still succeeds", async () => {
  const { deps } = makeDeps({
    saveInboxState: () => Promise.reject(new Error("disk full")),
  });

  const last = lastOf(
    await collect<InboxReadNextEvent>(
      inboxReadNext(createLibSwampContext(), deps),
    ),
  );

  assert(last.kind === "completed");
  assertEquals(last.view.marked, true);
});

Deno.test("inboxReadNext: a config dir this process does not own is left alone", async () => {
  const { deps, rec } = makeDeps({ ownsConfigDir: () => false });

  await collect<InboxReadNextEvent>(
    inboxReadNext(createLibSwampContext(), deps),
  );

  assertEquals(rec.marked.length, 1);
  assertEquals(rec.summaries, 0);
  assertEquals(rec.saved, []);
});

Deno.test("inboxReadNext: not signed in is notAuthenticated, with no call", async () => {
  for (const missing of [null, { ...credentials, apiKey: "" }]) {
    const { deps, rec } = makeDeps({ credentials: missing });

    const last = lastOf(
      await collect<InboxReadNextEvent>(
        inboxReadNext(createLibSwampContext(), deps),
      ),
    );

    assert(last.kind === "error");
    assertEquals(last.error.code, "not_authenticated");
    assertEquals(rec.listed, []);
  }
});

Deno.test("inboxReadNext: the client's UserErrors propagate unchanged", async () => {
  for (
    const message of [
      "The inbox needs a personal API key; collective keys have no inbox.",
      "https://swamp-club.com has no inbox.",
    ]
  ) {
    const thrown = new UserError(message);
    const { deps } = makeDeps({ listMessages: () => Promise.reject(thrown) });

    const error = await assertRejects(() =>
      collect<InboxReadNextEvent>(inboxReadNext(createLibSwampContext(), deps))
    );

    assertStrictEquals(error, thrown);
  }
});

Deno.test("inboxReadNext: an abort is cancelled", async () => {
  const { deps } = makeDeps({
    listMessages: () =>
      Promise.reject(new DOMException("aborted", "AbortError")),
  });

  const last = lastOf(
    await collect<InboxReadNextEvent>(
      inboxReadNext(createLibSwampContext(), deps),
    ),
  );

  assert(last.kind === "error");
  assertEquals(last.error.code, "cancelled");
});

Deno.test("markRead: marks exactly the given ids and refreshes the cache", async () => {
  const ids = ["01JBX5Q8ZK0000000000000104", "01JBX5Q8ZK00000000000000ZX"];
  const { deps, rec } = makeDeps();

  const last = lastOf(
    await collect<MarkReadEvent>(markRead(createLibSwampContext(), deps, ids)),
  );

  assert(last.kind === "completed");
  assertEquals(last.marked, ids);
  assertEquals(rec.marked, [ids]);
  assertEquals(rec.listed, []);
  assertEquals(rec.saved.length, 1);
});

Deno.test("markRead: no ids makes no request and loads no credentials", async () => {
  let loaded = false;
  const { deps, rec } = makeDeps({
    loadCredentials: () => {
      loaded = true;
      return Promise.resolve(credentials);
    },
  });

  const events = await collect<MarkReadEvent>(
    markRead(createLibSwampContext(), deps, []),
  );

  assertEquals(events, [{ kind: "completed", marked: [] }]);
  assertEquals(loaded, false);
  assertEquals(rec.marked, []);
  assertEquals(rec.summaries, 0);
});

Deno.test("markRead: a client UserError propagates unchanged", async () => {
  const thrown = new UserError("https://swamp-club.com has no inbox.");
  const { deps } = makeDeps({ markInboxRead: () => Promise.reject(thrown) });

  const error = await assertRejects(() =>
    collect<MarkReadEvent>(
      markRead(createLibSwampContext(), deps, ["01JBX5Q8ZK0000000000000104"]),
    )
  );

  assertStrictEquals(error, thrown);
});
