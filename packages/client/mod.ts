// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and\/or modify
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
// along with Swamp.  If not, see <https:\/\/www.gnu.org\/licenses\/>.

/**
 * typed client for the swamp serve WebSocket API, with callback and
 * AsyncIterable consumption of run events
 */

export { SwampClient } from "./client.ts";
export type { SwampClientOptions } from "./client.ts";

export type {
  DataGetPayload,
  DataListPayload,
  DataQueryPayload,
  DataResponse,
  DataSearchPayload,
  ModelMethodRunEvent,
  ModelMethodRunPayload,
  ModelMethodRunView,
  ModelSearchPayload,
  RunHistoryPayload,
  SerializedError,
  SerializedEvent,
  ServerMessage,
  ServerRequest,
  WorkflowRunEvent,
  WorkflowRunPayload,
  WorkflowRunSearchPayload,
  WorkflowRunView,
  WorkflowSearchPayload,
} from "./protocol.ts";

export {
  consumeStream,
  type EventHandlers,
  type HasTerminals,
  result,
  type StreamEvent,
  SwampClientError,
  withDefaults,
} from "./stream.ts";
