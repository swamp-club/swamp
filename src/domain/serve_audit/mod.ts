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

export {
  type AuditCategory,
  type AuditEvent,
  type AuditOutcome,
  type AuditStage,
  createAuditEvent,
} from "./audit_event.ts";

export {
  type AuditEventInput,
  buildAuditEvent,
} from "./audit_event_builder.ts";

export { AuditEmitter } from "./audit_emitter.ts";

export type { AuditSink } from "./audit_sink.ts";

export type { AuditStore } from "./audit_store.ts";

export { RingBuffer } from "./ring_buffer.ts";
