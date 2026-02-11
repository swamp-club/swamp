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
  createTelemetryId,
  generateTelemetryId,
  type TelemetryId,
} from "./telemetry_id.ts";

export {
  type CommandInvocation,
  type CommandInvocationData,
  commandInvocationToData,
  createCommandInvocation,
} from "./command_invocation.ts";

export {
  createErrorResult,
  createSuccessResult,
  type InvocationResult,
  type InvocationResultData,
  invocationResultFromData,
  invocationResultToData,
  type InvocationStatus,
} from "./invocation_result.ts";

export {
  type CreateTelemetryEntryProps,
  TelemetryEntry,
  type TelemetryEntryData,
} from "./telemetry_entry.ts";

export type { TelemetryRepository } from "./repositories.ts";

export type { TelemetrySender } from "./telemetry_sender.ts";

export {
  type TelemetryFlushConfig,
  TelemetryService,
} from "./telemetry_service.ts";
