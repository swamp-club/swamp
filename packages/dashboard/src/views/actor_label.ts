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

/** The audit event fields that say who acted. */
export interface AuditActor {
  initiatedBy: string;
  principalUsername?: string;
  principalEmail?: string;
}

/**
 * Who an audit event names as its actor: the username, the email, or both as
 * `username <email>`, whichever are known; the event's `initiatedBy` when
 * neither is (swamp-club#3076).
 */
export function actorLabel(event: AuditActor): string {
  const { principalUsername: username, principalEmail: email } = event;
  if (username && email) return `${username} <${email}>`;
  return username || email || event.initiatedBy;
}
