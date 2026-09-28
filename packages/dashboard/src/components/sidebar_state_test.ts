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
import {
  MOBILE_MEDIA_QUERY,
  parseCollapsed,
  resolveEscape,
} from "./sidebar_state.ts";

// ── parseCollapsed ──────────────────────────────────────────────────────

Deno.test("parseCollapsed: 'true' collapses", () => {
  assertEquals(parseCollapsed("true"), true);
});

Deno.test("parseCollapsed: 'false' stays expanded", () => {
  assertEquals(parseCollapsed("false"), false);
});

Deno.test("parseCollapsed: missing value stays expanded", () => {
  assertEquals(parseCollapsed(null), false);
});

Deno.test("parseCollapsed: unrecognised value stays expanded", () => {
  assertEquals(parseCollapsed("TRUE"), false);
  assertEquals(parseCollapsed("1"), false);
  assertEquals(parseCollapsed(""), false);
});

// ── resolveEscape ───────────────────────────────────────────────────────

Deno.test("resolveEscape: open drawer closes before a detail view", () => {
  assertEquals(resolveEscape(true, true), "close-drawer");
});

Deno.test("resolveEscape: open drawer closes with no detail view", () => {
  assertEquals(resolveEscape(true, false), "close-drawer");
});

Deno.test("resolveEscape: closed drawer closes the detail view", () => {
  assertEquals(resolveEscape(false, true), "leave-detail");
});

Deno.test("resolveEscape: nothing open does nothing", () => {
  assertEquals(resolveEscape(false, false), "none");
});

// ── MOBILE_MEDIA_QUERY ──────────────────────────────────────────────────

Deno.test("MOBILE_MEDIA_QUERY: matches the 768px breakpoint in styles.css", () => {
  assertEquals(MOBILE_MEDIA_QUERY, "(max-width: 768px)");
});
