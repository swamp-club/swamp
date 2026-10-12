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

import { useCallback, useEffect, useRef, useState } from "react";

// Page state kept in the URL's query string (?q=…&group=…), so a filtered
// view survives a reload and can be shared as a link. Writes replace the
// current history entry: typing in a search box must not flood Back.
// Back/Forward, and in-app navigation that pushes a URL with a query
// string (`navigateToHref` dispatches popstate), re-read the param.

/** The value `parse` makes of `?key=` in a query string. */
export function queryParamValue<T>(
  search: string,
  key: string,
  parse: (raw: string | null) => T,
): T {
  let raw: string | null = null;
  try {
    raw = new URLSearchParams(search).get(key);
  } catch {
    raw = null;
  }
  return parse(raw);
}

function currentSearch(): string {
  try {
    return globalThis.location?.search ?? "";
  } catch {
    return "";
  }
}

function writeParam(key: string, value: string | null): void {
  try {
    const url = new URL(globalThis.location.href);
    if (value === null || value === "") url.searchParams.delete(key);
    else url.searchParams.set(key, value);
    const history = (globalThis as {
      history?: {
        state: unknown;
        replaceState(state: unknown, unused: string, url: string): void;
      };
    }).history;
    history?.replaceState(history.state, "", url.toString());
  } catch {
    // No history API (tests, sandboxed frames): state lives in memory only.
  }
}

/**
 * A string piece of state mirrored to `?key=`. `parse` maps the raw param
 * (or null) to a value — return the default for anything invalid. Setting
 * the default value removes the param.
 */
const toParam = (v: unknown): string | null => String(v);

export function useQueryState<T>(
  key: string,
  defaultValue: T,
  parse: (raw: string | null) => T,
  serialize: (value: T) => string | null = toParam,
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() =>
    queryParamValue(currentSearch(), key, parse)
  );
  const parseRef = useRef(parse);
  parseRef.current = parse;
  useEffect(() => {
    const onPop = () =>
      setValue(queryParamValue(currentSearch(), key, parseRef.current));
    globalThis.addEventListener("popstate", onPop);
    return () => globalThis.removeEventListener("popstate", onPop);
  }, [key]);
  const set = useCallback((next: T) => {
    setValue(next);
    writeParam(key, next === defaultValue ? null : serialize(next));
  }, [key, defaultValue, serialize]);
  return [value, set];
}

/** Parses a param that must be one of `options`. */
export function oneOf<T extends string>(
  options: readonly T[],
  fallback: T,
): (raw: string | null) => T {
  return (raw) =>
    raw !== null && (options as readonly string[]).includes(raw)
      ? raw as T
      : fallback;
}

export const asString = (raw: string | null): string => raw ?? "";
export const asNullableString = (raw: string | null): string | null =>
  raw === null || raw === "" ? null : raw;
export const asFlag = (raw: string | null): boolean => raw === "1";
export const flagParam = (v: boolean): string | null => (v ? "1" : null);
export const nullableParam = (v: string | null): string | null => v;
