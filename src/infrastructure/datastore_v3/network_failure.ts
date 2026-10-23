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
 * Tells a storage call that never reached the datastore from one the
 * datastore answered (swamp-club#3759).
 *
 * The bucket datastore extensions wrap what their transport threw and keep it
 * as `cause`: S3 a Node-style error with a `code` (`ECONNREFUSED`,
 * `ETIMEDOUT`, `ENOTFOUND`, or an `AggregateError` of them for a host with
 * several addresses), GCS `fetch`'s `TypeError("fetch failed")` whose cause
 * reads "error sending request for url", and both a `TimeoutError` for a
 * request that ran past its timeout. An answered request (an HTTP status)
 * carries none of these. A connection lost while a response body was read
 * (Deno's "error reading a body from connection", swamp-club#3802) counts
 * too: the request reached the datastore, but nothing more can be read from
 * it, and on the commit path what it may have stored is content-addressed
 * chunk content, which a given-up commit never names. An `AbortError` is a
 * caller's cancel, not a failure to reach the datastore, and a bare
 * `TypeError` is what a bug throws, so neither counts.
 *
 * @module
 */

/** The Node-style error codes a connection that never completed carries. */
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

/** Deno's own errors for a connection that never completed. */
const NETWORK_ERROR_CLASSES: readonly (new (...args: never[]) => Error)[] = [
  Deno.errors.ConnectionRefused,
  Deno.errors.ConnectionReset,
  Deno.errors.ConnectionAborted,
  Deno.errors.TimedOut,
  Deno.errors.NotConnected,
  Deno.errors.AddrNotAvailable,
];

/** How far {@link isNetworkFailure} follows `cause` links. */
const MAX_DEPTH = 8;

/**
 * Whether `error`, or an error it wraps, says the request never reached the
 * datastore: a connection that failed, a lookup that failed, or a request
 * that timed out. An `AggregateError` counts only when every error in it
 * does.
 */
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

/** Whether `error` itself, not what it wraps, is a network failure. */
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
