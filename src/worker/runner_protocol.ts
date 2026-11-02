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
 * each runner gets a per-dispatch credential independent of the control
 * channel's, so session refreshes do not invalidate it
 */
export const RunnerBootstrapParamsSchema = z.object({
  sessionCredential: z.string().min(1),
  dataPlaneUrl: z.string().min(1),
  cacheDirPath: z.string().min(1),
  /**
   * made by the supervisor and removed once the runner exits, so a killed
   * runner leaves none behind; absent, the runner makes its own
   */
  scratchDirPath: z.string().min(1).optional(),
  dispatch: DispatchParamsSchema,
  caCerts: z.array(z.string().min(1)).optional(),
});

export type RunnerBootstrapParams = z.infer<
  typeof RunnerBootstrapParamsSchema
>;

export const RUNNER_CANCEL_GRACE_MS = 10_000;

export const RUNNER_ARGUMENTS_VALIDATED = "runner.argumentsValidated";
