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

import { UserError } from "../../domain/errors.ts";
import { hostIsTrusted, parseTrustedHost } from "../origin.ts";

/**
 * the extra Host names `swamp dashboard --trusted-hosts` lets through, read as
 * serve reads its own --trusted-hosts: an entry's port does not narrow the Host
 * check, and the page token is still required on every route
 */
export class TrustedHosts {
  static readonly NONE = new TrustedHosts([]);

  private constructor(readonly entries: readonly string[]) {}

  /** comma-separated, as serve takes it; an entry that is not host or host:port is refused */
  static parse(raw: string | undefined): TrustedHosts {
    if (raw === undefined) return TrustedHosts.NONE;
    const entries = raw.split(",").map((h) => h.trim()).filter((h) =>
      h.length > 0
    );
    if (entries.length === 0) {
      throw new UserError(
        "--trusted-hosts needs at least one host name, e.g. --trusted-hosts my-machine.example.ts.net",
      );
    }
    for (const entry of entries) {
      // URL parsing accepts "*" in a host name, so a wildcard is refused here.
      if (entry.includes("*") || parseTrustedHost(entry) === null) {
        throw new UserError(
          `--trusted-hosts entry ${
            JSON.stringify(entry)
          } is not a host name or host:port. Give the name your proxy sends, with no scheme, path or wildcard.`,
        );
      }
    }
    return new TrustedHosts(entries.map((entry) => entry.toLowerCase()));
  }

  acceptsHost(hostHeader: string | null): boolean {
    return hostIsTrusted(hostHeader, this.entries);
  }

  /**
   * the exact http or https origin of a trusted Host (a TLS-terminating proxy
   * serves the page on https); never for the loopback one
   */
  acceptsOrigin(origin: string, hostHeader: string | null): boolean {
    if (hostHeader === null || !this.acceptsHost(hostHeader)) return false;
    const host = hostHeader.toLowerCase();
    return origin.toLowerCase() === `https://${host}` ||
      origin.toLowerCase() === `http://${host}`;
  }
}
