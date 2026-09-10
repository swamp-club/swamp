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

import {
  assertAuditSinkConformance,
  type ConformanceAuditEvent,
  type ConformanceAuditSink,
} from "./audit_sink_conformance.ts";

class InMemoryAuditSink implements ConformanceAuditSink {
  readonly name = "in-memory-test";
  readonly durable = false;
  readonly events: ConformanceAuditEvent[] = [];
  #closed = false;

  async write(events: readonly ConformanceAuditEvent[]): Promise<void> {
    if (this.#closed) throw new Error("Sink is closed");
    this.events.push(...events);
    await Promise.resolve();
  }

  async flush(): Promise<void> {
    await Promise.resolve();
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.resolve();
  }
}

assertAuditSinkConformance({
  factory: async () => new InMemoryAuditSink(),
});
