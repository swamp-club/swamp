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

import type { AuditEvent } from "./audit_event.ts";

export interface AuditSink {
  readonly name: string;
  readonly durable: boolean;
  write(events: readonly AuditEvent[]): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

/**
 * sequences are lost to the sink and must be sent again; pending are still
 * being retried by it and must be kept but not resent; null means all events
 */
export class UnconfirmedEventsError extends Error {
  readonly sequences: ReadonlySet<number> | null;
  readonly pending: ReadonlySet<number> | null;

  constructor(
    message: string,
    sequences: ReadonlySet<number> | null,
    pending: ReadonlySet<number> | null = new Set(),
  ) {
    super(message);
    this.name = "UnconfirmedEventsError";
    this.sequences = sequences;
    this.pending = pending;
  }
}
