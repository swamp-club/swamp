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

import type {
  ModelMethodRunEvent,
  ModelMethodRunView,
} from "../client/protocol.ts";

export interface MethodRunState {
  readonly status: "idle" | "running" | "succeeded" | "failed" | "cancelled";
  readonly modelName?: string;
  readonly methodName?: string;
  /** The method's stdout and stderr lines, oldest first. */
  readonly output: readonly string[];
  /** The finished run, with the data it wrote. */
  readonly run?: ModelMethodRunView;
  readonly error?: string;
}

export const IDLE_METHOD_RUN: MethodRunState = { status: "idle", output: [] };

export type MethodRunAction =
  | { kind: "begin"; modelName: string; methodName: string }
  | { kind: "event"; event: ModelMethodRunEvent }
  | { kind: "failed"; error: string };

// a chatty method would otherwise grow the state without bound
const MAX_OUTPUT_LINES = 500;

/** Folds one method run's events into what an app shows. */
export function methodRunReducer(
  state: MethodRunState,
  action: MethodRunAction,
): MethodRunState {
  switch (action.kind) {
    case "begin":
      return {
        status: "running",
        modelName: action.modelName,
        methodName: action.methodName,
        output: [],
      };
    case "failed":
      return state.status === "failed"
        ? state
        : { ...state, status: "failed", error: action.error };
    case "event":
      return applyEvent(state, action.event);
  }
}

function applyEvent(
  state: MethodRunState,
  event: ModelMethodRunEvent,
): MethodRunState {
  switch (event.kind) {
    case "model_resolved":
      return { ...state, modelName: event.modelName };
    case "method_output":
      return {
        ...state,
        output: [...state.output, event.line].slice(-MAX_OUTPUT_LINES),
      };
    case "completed":
      return {
        ...state,
        status: event.run.status === "succeeded" ? "succeeded" : "failed",
        run: event.run,
        ...(event.run.status === "succeeded"
          ? {}
          : { error: `${event.run.methodName} finished ${event.run.status}` }),
      };
    case "cancelled":
      return {
        ...state,
        status: "cancelled",
        run: event.run,
        ...(event.reason !== undefined ? { error: event.reason } : {}),
      };
    case "error":
      return { ...state, status: "failed", error: event.error.message };
    default:
      return state;
  }
}
