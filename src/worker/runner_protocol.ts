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

import { z } from "zod";
import { DispatchParamsSchema } from "../domain/remote/protocol.ts";

/**
 * Bootstrap parameters sent as the first stdio frame from supervisor to
 * dispatch runner. The runner reads this to set up its data-plane client,
 * bundle cache, and RPC channel before executing the dispatch.
 *
 * Each runner receives a per-dispatch credential that is independent of
 * the control-channel credential. Session refreshes on the control
 * channel do not invalidate dispatch credentials.
 */
export const RunnerBootstrapParamsSchema = z.object({
  /** Bearer credential for the HTTP data plane (static at spawn time). */
  sessionCredential: z.string().min(1),
  /** Base URL of the orchestrator's HTTP data plane. */
  dataPlaneUrl: z.string().min(1),
  /** Path to the shared bundle cache directory. */
  cacheDirPath: z.string().min(1),
  /** The full dispatch parameters from the orchestrator. */
  dispatch: DispatchParamsSchema,
});

export type RunnerBootstrapParams = z.infer<
  typeof RunnerBootstrapParamsSchema
>;

/** Grace period before the supervisor kills an unresponsive runner child. */
export const RUNNER_CANCEL_GRACE_MS = 10_000;
