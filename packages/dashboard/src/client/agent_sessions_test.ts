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
import {
  AGENT_SESSION_LIST_SELECT,
  AGENT_SESSION_TOP_LEVEL_PREDICATE,
  agentSessionDataName,
  agentSessionTags,
} from "../../../../src/domain/agent_sessions/session_record.ts";
import { fixtureSessions } from "../views/agent_sessions/fixtures.ts";
import {
  appendWindow,
  CHILDREN_LIMIT,
  childrenPayload,
  DEFAULT_SESSION_SORT,
  detailPayload,
  filterRows,
  formatSessionSort,
  listPayload,
  listPredicate,
  pageOf,
  parseDetailReply,
  parseListReply,
  parseSessionSort,
  probePayload,
  repoLabel,
  reposOf,
  SESSION_LIST_LIMIT,
  SESSION_PAGE_SIZE,
  type SessionRow,
  sortRows,
} from "./agent_sessions.ts";

function listRow(session: ReturnType<typeof fixtureSessions>[number]) {
  return {
    name: agentSessionDataName(session.harness, session.id),
    modelName: "agent-sessions",
    tags: {
      type: "agent-session",
      ...agentSessionTags(session),
    } as Record<string, string>,
  };
}

function reply(rows: unknown[], limited = false) {
  return { projected: { shape: "map", rows }, total: rows.length, limited };
}

Deno.test("probePayload: one top-level session, tags only", () => {
  assertEquals(probePayload(), {
    predicate: AGENT_SESSION_TOP_LEVEL_PREDICATE,
    select: AGENT_SESSION_LIST_SELECT,
    limit: 1,
  });
});

Deno.test("listPayload: every list query carries a limit and the tag-only select", () => {
  const payload = listPayload();
  assertEquals(payload.limit, SESSION_LIST_LIMIT);
  assertEquals(payload.select, AGENT_SESSION_LIST_SELECT);
  // Newest first in SQL, and an older window follows the cursor.
  assertEquals(payload.sort, { field: "tags.startedAt", direction: "desc" });
  assertEquals("cursor" in payload, false);
  assertEquals(listPayload("abc").cursor, "abc");
  assertEquals(childrenPayload("parent-a")?.limit, CHILDREN_LIMIT);
  assertEquals(childrenPayload("parent-a")?.select, AGENT_SESSION_LIST_SELECT);
});

Deno.test("childrenPayload: refuses an id the record schema would refuse", () => {
  assertEquals(childrenPayload('x" || true || "'), null);
  assertEquals(childrenPayload("Upper"), null);
});

Deno.test("parseListReply: newest first by the startedAt tag", () => {
  const sessions = fixtureSessions().filter((s) => !s.parentSessionId);
  const list = parseListReply(reply(sessions.map(listRow)));
  const starts = list.rows.map((r) => r.startedAt);
  assertEquals(starts, [...starts].sort().reverse());
  assertEquals(list.rows.length, 3);
  assert(list.rows.every((r) => r.summary !== undefined));
  assertEquals(
    list.rows.find((r) => r.headless)?.summary?.invocation,
    "headless",
  );
});

Deno.test("parseListReply: keeps a row whose summary does not read, drops one that is not a row", () => {
  const [session] = fixtureSessions();
  const broken = listRow(session);
  broken.tags.summary = "{not json";
  const list = parseListReply(
    reply([broken, { name: 7 }, null, { name: "x", modelName: "m" }], true),
  );
  assertEquals(list.rows.length, 1);
  assertEquals(list.rows[0].summary, undefined);
  assertEquals(list.limited, true);
  assertEquals(parseListReply("nonsense"), { rows: [], limited: false });
});

Deno.test("filterRows: headless filter", () => {
  const rows = parseListReply(
    reply(fixtureSessions().filter((s) => !s.parentSessionId).map(listRow)),
  ).rows;
  assertEquals(filterRows(rows, "headless").length, 1);
  assertEquals(filterRows(rows, "interactive").length, 2);
  assertEquals(filterRows(rows, "all").length, 3);
});

function listed(): readonly SessionRow[] {
  return parseListReply(
    reply(fixtureSessions().filter((s) => !s.parentSessionId).map(listRow)),
  ).rows;
}

Deno.test("sortRows: by a figure either way, ties keep newest first", () => {
  const rows = listed();
  const calls = (r: SessionRow) => r.summary!.calls;
  const desc = sortRows(rows, { key: "calls", dir: "desc" }).map(calls);
  assertEquals(desc, [...desc].sort((a, b) => b - a));
  const asc = sortRows(rows, { key: "calls", dir: "asc" }).map(calls);
  assertEquals(asc, [...desc].reverse());
  assertEquals(
    sortRows(rows, DEFAULT_SESSION_SORT).map((r) => r.name),
    rows.map((r) => r.name),
  );
});

Deno.test("sortRows: text A to Z, and a row without a summary goes last", () => {
  const [first, ...rest] = listed();
  const bare: SessionRow = {
    ...first,
    name: "zz-bare",
    summary: undefined,
    repo: undefined,
  };
  for (const dir of ["asc", "desc"] as const) {
    const sorted = sortRows([bare, ...rest, first], { key: "repo", dir });
    assertEquals(sorted.at(-1)!.name, "zz-bare");
  }
  const repos = sortRows(rest, { key: "repo", dir: "asc" }).map((r) =>
    r.summary!.repo
  );
  assertEquals(repos, [...repos].sort((a, b) => a.localeCompare(b)));
});

Deno.test("sortRows: findings put any high above any number of mediums", () => {
  const [a, b] = listed();
  const high = {
    ...a,
    name: "high",
    summary: {
      ...a.summary!,
      findings: { high: 1, medium: 0, low: 0, info: 0 },
    },
  };
  const mediums = {
    ...b,
    name: "mediums",
    summary: {
      ...b.summary!,
      findings: { high: 0, medium: 40, low: 0, info: 0 },
    },
  };
  assertEquals(
    sortRows([mediums, high], { key: "findings", dir: "desc" }).map((r) =>
      r.name
    ),
    ["high", "mediums"],
  );
});

Deno.test("parseSessionSort: round-trips, and the default leaves the address clean", () => {
  const sort = { key: "failed", dir: "asc" } as const;
  assertEquals(parseSessionSort(formatSessionSort(sort)), sort);
  assertEquals(formatSessionSort(DEFAULT_SESSION_SORT), null);
  assertEquals(parseSessionSort("nope.asc"), DEFAULT_SESSION_SORT);
  assertEquals(parseSessionSort("calls.sideways"), DEFAULT_SESSION_SORT);
});

Deno.test("parseListReply: keeps the cursor for the next window", () => {
  const rows = fixtureSessions().filter((s) => !s.parentSessionId).map(
    listRow,
  );
  const list = parseListReply({
    projected: { rows },
    limited: true,
    nextCursor: "next",
  });
  assertEquals(list.nextCursor, "next");
  assertEquals(parseListReply(reply(rows)).nextCursor, undefined);
});

Deno.test("appendWindow: adds the older window, the newer row wins, the older cursor carries on", () => {
  const [a, b, c] = listed();
  const merged = appendWindow(
    { rows: [a, b], limited: true, nextCursor: "one" },
    {
      rows: [{ ...b, headless: !b.headless }, c],
      limited: false,
    },
  );
  assertEquals(merged.rows.map((r) => r.name), [a, b, c].map((r) => r.name));
  assertEquals(merged.rows[1].headless, b.headless);
  assertEquals(merged.nextCursor, undefined);
  assertEquals(merged.limited, false);
});

Deno.test("listPredicate: a repo adds its tag, and untagged sessions still pass", () => {
  assertEquals(listPredicate(), AGENT_SESSION_TOP_LEVEL_PREDICATE);
  assertEquals(
    listPredicate("acme-platform"),
    `${AGENT_SESSION_TOP_LEVEL_PREDICATE} && (tags.repo == "acme-platform" || !has(tags.repo))`,
  );
  // A repo the record schema refuses lists everything instead of throwing.
  assertEquals(listPredicate(""), AGENT_SESSION_TOP_LEVEL_PREDICATE);
  assertEquals(listPayload("c", "r").predicate, listPredicate("r"));
});

Deno.test("filterRows: a repo matches the tag, or the summary when there is no tag", () => {
  const [a, b, c] = listed();
  const tagged = { ...a, repo: "git.example.test/acme/one" };
  const untagged = { ...b, repo: undefined };
  const rows = [tagged, untagged, c];
  assertEquals(
    filterRows(rows, "all", "git.example.test/acme/one").map((r) => r.name),
    [tagged.name],
  );
  assertEquals(
    filterRows(rows, "all", untagged.summary!.repo).map((r) => r.name)
      .includes(untagged.name),
    true,
  );
  assertEquals(reposOf(rows), [
    "acme-platform",
    "git.example.test/acme/one",
  ]);
});

Deno.test("parseListReply: reads the repo tag", () => {
  const [session] = fixtureSessions();
  const row = listRow(session);
  const list = parseListReply(reply([row]));
  assertEquals(list.rows[0].repo, session.repo);
});

Deno.test("repoLabel: owner/name for a remote, the last folder for a path", () => {
  assertEquals(
    repoLabel("git.swamp-club.com/swamp-club/swamp-extensions"),
    "swamp-club/swamp-extensions",
  );
  assertEquals(repoLabel("~/code/acme"), "acme");
  assertEquals(repoLabel("acme-platform"), "acme-platform");
  assertEquals(repoLabel("/"), "/");
});

Deno.test("pageOf: pages of the page size, clamped", () => {
  const rows = Array.from({ length: 120 }, (_, i) => ({
    name: `s-${i}`,
    modelName: "m",
    startedAt: "",
    headless: false,
  } satisfies SessionRow));
  assertEquals(pageOf(rows, 0).rows.length, SESSION_PAGE_SIZE);
  assertEquals(pageOf(rows, 2).rows.length, 20);
  assertEquals(pageOf(rows, 9).page, 2);
  assertEquals(pageOf(rows, -1).page, 0);
  assertEquals(pageOf([], 0), { rows: [], pages: 1, page: 0 });
});

Deno.test("detailPayload: opens the row's data under its behavior", () => {
  const row = parseListReply(reply([listRow(fixtureSessions()[0])])).rows[0];
  assertEquals(detailPayload(row), {
    modelIdOrName: "agent-sessions",
    dataName: row.name,
    includeContent: true,
  });
});

Deno.test("parseDetailReply: reads a record, and skips what is not one without throwing", () => {
  const [session] = fixtureSessions();
  const content = JSON.stringify(session);
  assertEquals(
    parseDetailReply({ content, contentEncoding: "utf-8" }).kind,
    "record",
  );
  assertEquals(parseDetailReply({ content }).kind, "record");
  const base64 = parseDetailReply({ content, contentEncoding: "base64" });
  assertEquals(base64.kind === "skipped" && base64.reason, "invalid");
  const bad = parseDetailReply({ content: "{" });
  assertEquals(bad.kind === "skipped" && bad.reason, "invalid");
  const older = parseDetailReply({
    content: JSON.stringify({ ...session, schemaVersion: 1 }),
  });
  assertEquals(older.kind === "skipped" && older.reason, "older");
  assertEquals(parseDetailReply(undefined).kind, "skipped");
});
