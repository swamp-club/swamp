/**
 * @systeminit/swamp-lib — TypeScript client for the swamp WebSocket API.
 *
 * ```typescript
 * import { SwampClient } from "@systeminit/swamp-lib";
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
