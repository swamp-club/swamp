// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
  type BashCommandEntry,
  type BashCommandEntryData,
  bashCommandEntryFromData,
  bashCommandEntryToData,
  createBashCommandEntry,
} from "./audit_command_entry.ts";

export {
  type AuditEntry,
  type AuditEntryData,
  auditEntryToData,
  type AuditSource,
  type AuditStatus,
  createDirectAuditEntry,
  createSwampAuditEntry,
} from "./audit_entry.ts";

export type { AuditRepository } from "./audit_repository.ts";

export {
  AuditService,
  type AuditTimeline,
  type AuditTimelineOptions,
  isNoiseCommand,
} from "./audit_service.ts";
