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

import { UserError } from "../errors.ts";

/**
 * Most results one data query page returns. Serve caps every request at it,
 * and a sorted query given no limit is capped at it, so every sorted page is
 * bounded (swamp-club#4177).
 */
export const MAX_QUERY_RESULTS = 10_000;

/** Longest cursor token a query accepts. */
export const MAX_QUERY_CURSOR_LENGTH = 16_384;

export type QuerySortDirection = "asc" | "desc";

/**
 * The order of a sorted data query: `createdAt`, or one tag's value as
 * `tags.<key>`. Both compare as strings, so ISO 8601 UTC times sort in time
 * order, and a row without the tag sorts as the empty string. Ties break on
 * the item's identity, so the order is total.
 */
export interface QuerySort {
  readonly field: string;
  readonly direction: QuerySortDirection;
}

/**
 * A row's place in a sorted query: its sort value and its identity
 * (namespace, model type, model id, data name, version), the tie-break.
 */
export interface QueryCursorPosition {
  readonly key: string;
  readonly id: readonly [string, string, string, string, number];
}

const TAG_PREFIX = "tags.";
// Quoted into a JSON path, so it may hold no quote or backslash.
const TAG_KEY = /^[A-Za-z0-9_.-]{1,128}$/;
const CURSOR_VERSION = 1;

/**
 * Validates a sort's field and direction and returns it as a QuerySort.
 * Throws a UserError naming what is wrong.
 */
export function createQuerySort(
  field: string,
  direction: string,
): QuerySort {
  if (direction !== "asc" && direction !== "desc") {
    throw new UserError(
      `Sort direction must be "asc" or "desc", got ${
        JSON.stringify(direction)
      }`,
    );
  }
  if (field !== "createdAt") {
    const key = field.startsWith(TAG_PREFIX)
      ? field.slice(TAG_PREFIX.length)
      : null;
    if (key === null || !TAG_KEY.test(key)) {
      throw new UserError(
        `Cannot sort by ${JSON.stringify(field)}: sort by createdAt or ` +
          `tags.<key>, where the key is letters, digits, ".", "_" or "-"`,
      );
    }
  }
  return { field, direction };
}

/**
 * Parses a sort as the CLI writes it: `<field>` or `<field>:asc|desc`,
 * ascending when no direction is given.
 */
export function parseQuerySort(text: string): QuerySort {
  const colon = text.lastIndexOf(":");
  if (colon === -1) return createQuerySort(text, "asc");
  return createQuerySort(text.slice(0, colon), text.slice(colon + 1));
}

/** The tag key a sort orders by, or null when it orders by createdAt. */
export function querySortTagKey(sort: QuerySort): string | null {
  if (sort.field === "createdAt") return null;
  return createQuerySort(sort.field, sort.direction).field.slice(
    TAG_PREFIX.length,
  );
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/,
    "",
  );
}

function fromBase64Url(token: string): string {
  if (!/^[A-Za-z0-9_-]*$/.test(token)) throw new Error("not base64url");
  const base64 = token.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/**
 * Encodes the position of a page's last row as an opaque cursor token. It
 * holds the sort and the row's sort value and identity, nothing else.
 */
export function encodeQueryCursor(
  sort: QuerySort,
  position: QueryCursorPosition,
): string {
  return toBase64Url(JSON.stringify({
    v: CURSOR_VERSION,
    f: sort.field,
    d: sort.direction,
    k: position.key,
    id: position.id,
  }));
}

/**
 * Decodes a cursor token for a query sorted by `sort`. Throws a UserError
 * for a malformed token, or one made for a different sort.
 */
export function decodeQueryCursor(
  token: string,
  sort: QuerySort,
): QueryCursorPosition {
  const invalid = () =>
    new UserError(
      "Invalid query cursor: pass the nextCursor a previous page of the " +
        "same sorted query returned",
    );
  if (token.length === 0 || token.length > MAX_QUERY_CURSOR_LENGTH) {
    throw invalid();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(token));
  } catch {
    throw invalid();
  }
  if (parsed === null || typeof parsed !== "object") throw invalid();
  const { v, f, d, k, id } = parsed as Record<string, unknown>;
  if (
    v !== CURSOR_VERSION || typeof k !== "string" || !Array.isArray(id) ||
    id.length !== 5 || !id.slice(0, 4).every((s) => typeof s === "string") ||
    !Number.isSafeInteger(id[4])
  ) {
    throw invalid();
  }
  if (f !== sort.field || d !== sort.direction) {
    throw new UserError(
      `This cursor belongs to a query sorted by ${String(f)}:${String(d)}, ` +
        `not ${sort.field}:${sort.direction}`,
    );
  }
  return {
    key: k,
    id: id as unknown as [string, string, string, string, number],
  };
}
