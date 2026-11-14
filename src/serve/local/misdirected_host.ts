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

import { parseTrustedHost } from "../origin.ts";

// Only these characters are echoed, so a refused Host can never carry markup,
// a log placeholder or a line break into the body or the terminal.
const HOST_NAME = /^[a-z0-9.-]+$/;
const BRACKETED_IPV6 = /^\[[0-9a-f:.]+\]$/;
const MAX_ECHOED_LENGTH = 255;
const DEFAULT_LOG_LIMIT = 32;

export interface RefusedHost {
  /** lower-cased with any port dropped; null when it is not echoed */
  readonly host: string | null;
  readonly message: string;
}

function echoableHost(hostHeader: string): string | null {
  if (hostHeader.length > MAX_ECHOED_LENGTH) return null;
  const header = hostHeader.toLowerCase();
  const host = header.startsWith("[")
    ? header.replace(/(\])(:\d+)?$/, "$1")
    : header.replace(/:\d+$/, "");
  if (!BRACKETED_IPV6.test(host) && !HOST_NAME.test(host)) return null;
  // Only a host --trusted-hosts would take, so the hint always works.
  return parseTrustedHost(host) === null ? null : host;
}

/**
 * `command` is the swamp command whose --trusted-hosts would let the host in;
 * null for a server the flag does not reach
 */
export function refusedHost(
  hostHeader: string | null,
  command: string | null,
): RefusedHost {
  const subject = command ?? "this server";
  if (hostHeader === null || hostHeader === "") {
    return {
      host: null,
      message: `Misdirected request: the request has no Host header.`,
    };
  }
  const host = echoableHost(hostHeader);
  if (host === null) {
    return {
      host: null,
      message:
        `Misdirected request: ${subject} refused a Host header that is not a valid host name.`,
    };
  }
  const refusal =
    `Misdirected request: ${subject} does not answer for host "${host}".`;
  return {
    host,
    message: command === null
      ? refusal
      : `${refusal} To allow it, start ${command} with --trusted-hosts ${host}`,
  };
}

export function misdirectedResponse(refused: RefusedHost): Response {
  return new Response(refused.message, {
    status: 421,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/**
 * warns once per refused host; remembers at most `limit` hosts, then says once
 * that it stops, so a stream of made-up Hosts cannot grow it
 */
export class RefusedHostLog {
  readonly #seen = new Set<string>();
  #full = false;

  constructor(
    private readonly warn: (message: string) => void,
    private readonly limit = DEFAULT_LOG_LIMIT,
  ) {}

  note(refused: RefusedHost): void {
    if (this.#full) return;
    // Every host that is not echoed shares one entry.
    const key = refused.host ?? "";
    if (this.#seen.has(key)) return;
    if (this.#seen.size >= this.limit) {
      this.#full = true;
      this.warn(
        `Refused requests for ${this.limit} different hosts; further refused hosts are not logged.`,
      );
      return;
    }
    this.#seen.add(key);
    this.warn(refused.message);
  }
}
