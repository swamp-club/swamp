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

export { SwampClient } from "../client/client.ts";
export { SwampClientError } from "../client/stream.ts";
// every request, reply and event type, so an app never reaches into the copy
export type * from "../client/protocol.ts";
export type {
  DataChangesPage,
  RunAttachNotice,
  RunFollowEvent,
  StreamOptions,
  SwampTransport,
} from "../client/client.ts";
export {
  IDLE_RUN,
  type RunAction,
  runClock,
  type RunJobState,
  type RunLogEntry,
  runReducer,
  type RunState,
  type RunStatus,
  type RunStepState,
  type RunStreamEvent,
  stepKey,
} from "./run_state.ts";
export {
  type DataChangesMode,
  type FollowDataChanges,
  followDataChanges,
} from "./data_changes.ts";
export {
  IDLE_METHOD_RUN,
  type MethodRunAction,
  methodRunReducer,
  type MethodRunState,
} from "./method_run_state.ts";
export {
  APP_READY_MESSAGE,
  type AppInfo,
  type AppMessage,
  type AppTheme,
  BRIDGE_VERSION,
  type BridgeFrame,
  type BridgePort,
  type HostMessage,
  isAppMessage,
} from "./bridge.ts";
export {
  type BridgeListeners,
  type BridgeSession,
  BridgeTransport,
} from "./bridge_transport.ts";
export {
  APP_READ_CAPABILITIES,
  type AppGrant,
  type AppMethodGrant,
  type AppReadCapability,
  CANCEL_REQUEST,
  CAPABILITY_REQUESTS,
  decideAppRequest,
  exposedRequestTypes,
  holdsExpression,
  METHOD_REQUEST,
  RUN_REQUEST,
} from "./capabilities.ts";
export {
  type AppConnector,
  connectApp,
  type ConnectedApp,
  createAppConnector,
} from "./connect.ts";
export {
  createMockHost,
  type MockHostOptions,
  type MockStreamEvent,
} from "./mock_host.ts";
