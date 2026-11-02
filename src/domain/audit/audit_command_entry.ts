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

export interface BashCommandEntry {
  readonly timestamp: string;
  readonly sessionId?: string;
  readonly command: string;
  readonly cwd: string;
  /** Exit code, present only for failed commands (PostToolUseFailure) */
  readonly exitCode?: number;
  readonly error?: string;
}

export interface BashCommandEntryData {
  timestamp: string;
  sessionId?: string;
  command: string;
  cwd: string;
  exitCode?: number;
  error?: string;
}

export function createBashCommandEntry(
  sessionId: string | undefined,
  command: string,
  cwd: string,
  failure?: { exitCode?: number; error?: string },
): BashCommandEntry {
  const entry: BashCommandEntry = {
    timestamp: new Date().toISOString(),
    ...(sessionId !== undefined ? { sessionId } : {}),
    command,
    cwd,
    ...(failure?.exitCode !== undefined ? { exitCode: failure.exitCode } : {}),
    ...(failure?.error ? { error: failure.error } : {}),
  };
  return entry;
}

export function bashCommandEntryFromData(
  data: BashCommandEntryData,
): BashCommandEntry {
  const entry: BashCommandEntry = {
    timestamp: data.timestamp,
    ...(data.sessionId !== undefined ? { sessionId: data.sessionId } : {}),
    command: data.command,
    cwd: data.cwd,
    ...(data.exitCode !== undefined ? { exitCode: data.exitCode } : {}),
    ...(data.error ? { error: data.error } : {}),
  };
  return entry;
}

export function bashCommandEntryToData(
  entry: BashCommandEntry,
): BashCommandEntryData {
  const data: BashCommandEntryData = {
    timestamp: entry.timestamp,
    command: entry.command,
    cwd: entry.cwd,
  };
  if (entry.sessionId !== undefined) {
    data.sessionId = entry.sessionId;
  }
  if (entry.exitCode !== undefined) {
    data.exitCode = entry.exitCode;
  }
  if (entry.error) {
    data.error = entry.error;
  }
  return data;
}
