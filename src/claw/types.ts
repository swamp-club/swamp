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

/** Supported chat platform identifiers. */
export type PlatformId = "discord" | "slack" | "whatsapp" | "twilio" | "web";

/** A platform-agnostic representation of an inbound chat message. */
export interface NormalizedMessage {
  readonly platform: PlatformId;
  readonly channelId: string;
  readonly userId: string;
  readonly userName: string;
  readonly messageId: string;
  readonly text: string;
  readonly timestamp: Date;
}

/** The result of parsing a chat message into a structured command. */
export interface ParsedCommand {
  readonly domain: string;
  readonly verb: string;
  readonly target: string;
  readonly options: ReadonlyMap<string, string>;
  readonly raw: string;
}

/** Result sent back to the platform after command execution. */
export interface CommandResponse {
  readonly text: string;
  readonly success: boolean;
}

/** Progress update sent during long-running operations. */
export interface ProgressUpdate {
  readonly text: string;
}
