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
 * distinct from 'extension does not exist', so auto-resolution can report an
 * outage; named UserError so CLI output is unchanged, while constructor.name
 * readers see RegistryUnavailableError
 */
export class RegistryUnavailableError extends UserError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "UserError";
    // Non-enumerable like a native Error cause, so spreading or serialising
    // the error never carries the underlying failure into output.
    if (options?.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        value: options.cause,
        enumerable: false,
        writable: true,
        configurable: true,
      });
    }
  }
}

export interface ServerFault {
  status: number;
  retried?: string;
  serverMessage?: string;
  url?: string;
}

// the client already retried these, so only time helps; any other 5xx is a server bug that repeats
const UNAVAILABLE_STATUSES = new Set([502, 503, 504]);

const BARE_STATUS_TEXT =
  /^(internal server error|bad gateway|service unavailable|gateway timeout)$/i;

export function serverFaultMessage(fault: ServerFault): string {
  const said = fault.serverMessage?.trim().replace(/\.+$/, "");
  const detail = said && !BARE_STATUS_TEXT.test(said) ? `: ${said}` : "";
  const answering = fault.url ? ` answering ${fault.url}` : "";
  if (UNAVAILABLE_STATUSES.has(fault.status)) {
    const retried = fault.retried ? `, still failing${fault.retried}` : "";
    return `swamp-club is unavailable (HTTP ${fault.status}${retried})` +
      `${answering}${detail}. Try again in a few minutes.`;
  }
  return `swamp-club hit an internal error (HTTP ${fault.status})` +
    `${answering}${detail}. Retrying will most likely fail the same way; ` +
    "report it with `swamp issue bug` and include this message.";
}

export class RegistryServerError extends RegistryUnavailableError {
  constructor(fault: ServerFault) {
    super(serverFaultMessage(fault));
  }
}
