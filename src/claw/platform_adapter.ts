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

import type {
  CommandResponse,
  NormalizedMessage,
  PlatformId,
  ProgressUpdate,
} from "./types.ts";

/**
 * Abstraction over a chat platform's webhook interface.
 * Each platform (Discord, Slack, WhatsApp, etc.) implements this
 * to normalize inbound messages and format outbound responses.
 */
export interface PlatformAdapter {
  readonly platformId: PlatformId;

  /** Validate the inbound webhook request (e.g., signature verification). */
  verifyRequest(request: Request): Promise<boolean>;

  /** Parse the inbound webhook payload into a NormalizedMessage, or null if not actionable. */
  parseMessage(request: Request): Promise<NormalizedMessage | null>;

  /** Send a response back to the originating channel. */
  sendResponse(
    channelId: string,
    response: CommandResponse,
  ): Promise<void>;

  /** Send a progress update during long-running operations. */
  sendProgress(
    channelId: string,
    update: ProgressUpdate,
  ): Promise<void>;
}
