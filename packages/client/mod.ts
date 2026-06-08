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
 * @swamp-club/swamp-lib — TypeScript client for the swamp WebSocket API.
 *
 * ```typescript
 * import { SwampClient } from "@swamp-club/swamp-lib";
 *
 * const client = new SwampClient("ws://localhost:9090");
 * await client.connect();
 *
 * // Callback-based: resolves with completed payload
 * const run = await client.workflowRun(
 *   { workflowIdOrName: "my-workflow", inputs: { env: "dev" } },
 *   { started: (e) => console.log(`Run ${e.runId} started`) },
 * );
 *
 * // AsyncIterable-based: for-await-of event stream
 * for await (const event of client.workflowRunStream({ workflowIdOrName: "my-workflow" })) {
 *   console.log(event.kind);
 * }
 *
 * client.close();
 * ```
 *
 * @module
 */

export { SwampClient } from "./client.ts";

// Protocol types
export type {
  ModelMethodRunEvent,
  ModelMethodRunPayload,
  ModelMethodRunView,
  SerializedError,
  SerializedEvent,
  ServerMessage,
  ServerRequest,
  WorkflowRunEvent,
  WorkflowRunPayload,
  WorkflowRunView,
} from "./protocol.ts";

// Stream helpers
export {
  consumeStream,
  type EventHandlers,
  type HasTerminals,
  result,
  type StreamEvent,
  SwampClientError,
  withDefaults,
} from "./stream.ts";
