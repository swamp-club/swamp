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

/**
 * a lost connection while a body was read counts, since on the commit path what
 * it stored is content-addressed chunks a given-up commit never names;
 * AbortError (caller cancel) and a bare TypeError (a bug) do not
 */

const NETWORK_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "ENETUNREACH",
  "ENETDOWN",
  "EPIPE",
]);

const NETWORK_ERROR_CLASSES: readonly (new (...args: never[]) => Error)[] = [
  Deno.errors.ConnectionRefused,
  Deno.errors.ConnectionReset,
  Deno.errors.ConnectionAborted,
  Deno.errors.TimedOut,
  Deno.errors.NotConnected,
  Deno.errors.AddrNotAvailable,
];

const MAX_DEPTH = 8;

/** an AggregateError counts only when every error in it does */
export function isNetworkFailure(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    if (!(current instanceof Error)) return false;
    if (isNetworkError(current)) return true;
    if (current instanceof AggregateError) {
      return current.errors.length > 0 &&
        current.errors.every((member) => isNetworkFailure(member));
    }
    current = current.cause;
  }
  return false;
}

function isNetworkError(error: Error): boolean {
  if (error.name === "TimeoutError") return true;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && NETWORK_CODES.has(code)) return true;
  if (NETWORK_ERROR_CLASSES.some((type) => error instanceof type)) return true;
  // Deno's fetch: a TypeError("fetch failed") whose cause says the request
  // could not be sent, or a body read the connection was lost under.
  if (error.message.startsWith("error sending request for url")) return true;
  if (error.message.startsWith("error reading a body from connection")) {
    return true;
  }
  return error instanceof TypeError && error.message === "fetch failed";
}
