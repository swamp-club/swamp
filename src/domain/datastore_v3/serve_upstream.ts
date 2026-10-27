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
import { normalizeServerUrl } from "../auth/server_url.ts";

/** What {@link ServeUpstreamTarget.create} takes. */
export interface ServeUpstreamTargetInput {
  /** The serve address, as configured: http(s) or ws(s). */
  serverUrl: string;
  /** The bearer token bound to this address, when there is one. */
  token?: string;
  /** PEM-encoded CA certificates to trust for the TLS connection. */
  caCerts?: readonly string[];
  /** Extra headers for proxy or tunnel pass-through. */
  extraHeaders?: Readonly<Record<string, string>>;
}

// deno-lint-ignore no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

/**
 * Header names a pass-through header may not set: the token travels in
 * `authorization`, and the others belong to the connection itself.
 */
const RESERVED_HEADER_NAMES = new Set([
  "authorization",
  "host",
  "upgrade",
  "connection",
]);

/**
 * The swamp serve a v3 checkout uses as its datastore upstream, with what
 * the client needs to reach it: the normalized http(s) address, the token
 * bound to that address, the CA certificates to trust and any pass-through
 * headers.
 *
 * Immutable. Equal targets are equal by value; {@link equals} compares them.
 * The token never appears in {@link toString} or JSON output.
 */
export class ServeUpstreamTarget {
  private constructor(
    /** The normalized http(s) address (see `normalizeServerUrl`). */
    readonly serverUrl: string,
    readonly token: string | undefined,
    readonly caCerts: readonly string[] | undefined,
    readonly extraHeaders: Readonly<Record<string, string>>,
  ) {}

  /**
   * Validates and normalizes the input.
   *
   * @throws {UserError} when the address is not an http(s) or ws(s) URL,
   *   the token is empty or holds whitespace or control characters, a CA
   *   certificate is empty, or a header is reserved or holds control
   *   characters. No message echoes the address, the token or a header
   *   value, any of which can carry a credential.
   */
  static create(input: ServeUpstreamTargetInput): ServeUpstreamTarget {
    let serverUrl: string;
    try {
      serverUrl = normalizeServerUrl(input.serverUrl);
    } catch {
      throw new UserError(
        "The serve address is not a valid http(s) or ws(s) URL — fix " +
          "SWAMP_SERVE_URL, SWAMP_SERVER_URL or the serverAddress in .swamp.yaml",
      );
    }

    const token = input.token;
    if (token !== undefined) {
      if (token === "" || /\s/.test(token) || CONTROL_CHAR_RE.test(token)) {
        throw new UserError(
          "The serve token is empty or holds whitespace or control characters",
        );
      }
    }

    let caCerts: readonly string[] | undefined;
    if (input.caCerts !== undefined && input.caCerts.length > 0) {
      if (input.caCerts.some((cert) => cert.trim() === "")) {
        throw new UserError("A CA certificate for the serve address is empty");
      }
      caCerts = Object.freeze([...input.caCerts]);
    }

    const extraHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(input.extraHeaders ?? {})) {
      if (name === "" || CONTROL_CHAR_RE.test(name)) {
        throw new UserError(
          "A pass-through header name is empty or holds control characters",
        );
      }
      if (RESERVED_HEADER_NAMES.has(name.toLowerCase())) {
        throw new UserError(
          `Header name ${
            JSON.stringify(name)
          } is reserved and cannot be overridden`,
        );
      }
      if (CONTROL_CHAR_RE.test(value)) {
        throw new UserError(
          `Value for header ${
            JSON.stringify(name)
          } contains control characters`,
        );
      }
      extraHeaders[name] = value;
    }

    return new ServeUpstreamTarget(
      serverUrl,
      token,
      caCerts,
      Object.freeze(extraHeaders),
    );
  }

  /** Whether a token is bound to this address. */
  get hasToken(): boolean {
    return this.token !== undefined;
  }

  equals(other: ServeUpstreamTarget): boolean {
    if (this.serverUrl !== other.serverUrl) return false;
    if (this.token !== other.token) return false;
    const a = this.caCerts ?? [];
    const b = other.caCerts ?? [];
    if (a.length !== b.length || a.some((cert, i) => cert !== b[i])) {
      return false;
    }
    const ha = Object.entries(this.extraHeaders).sort(([x], [y]) =>
      x < y ? -1 : x > y ? 1 : 0
    );
    const hb = Object.entries(other.extraHeaders).sort(([x], [y]) =>
      x < y ? -1 : x > y ? 1 : 0
    );
    return ha.length === hb.length &&
      ha.every(([name, value], i) => hb[i][0] === name && hb[i][1] === value);
  }

  /** The address only: never the token. */
  toString(): string {
    return this.serverUrl;
  }

  /** The address and whether a token is bound: never the token itself. */
  toJSON(): { serverUrl: string; hasToken: boolean } {
    return { serverUrl: this.serverUrl, hasToken: this.hasToken };
  }
}
