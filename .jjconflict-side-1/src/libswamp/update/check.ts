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

import type { Platform } from "../../domain/update/platform.ts";
import {
  type UpdateResult,
  UpdateService,
} from "../../domain/update/update_service.ts";
import { HttpUpdateChecker } from "../../infrastructure/update/http_update_checker.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";

/**
 * Data structure for the update check/install output.
 */
export type UpdateCheckData = UpdateResult;

export type UpdateCheckEvent =
  | { kind: "checking" }
  | { kind: "completed"; data: UpdateCheckData }
  | { kind: "error"; error: SwampError };

/** Input for the update check/install operation. */
export interface UpdateCheckInput {
  checkOnly: boolean;
  platform: Platform;
}

/** Dependencies for the update check/install operation. */
export interface UpdateCheckDeps {
  check: (platform: Platform) => Promise<UpdateResult>;
  update: (platform: Platform) => Promise<UpdateResult>;
}

/** Wires real infrastructure into UpdateCheckDeps. */
export function createUpdateCheckDeps(
  currentVersion: string,
  binaryPath: string,
): UpdateCheckDeps {
  const checker = new HttpUpdateChecker();
  const service = new UpdateService(checker, currentVersion, binaryPath);
  return {
    check: (platform) => service.check(platform),
    update: (platform) => service.update(platform),
  };
}

/** Checks for or installs updates. */
export async function* updateCheck(
  ctx: LibSwampContext,
  deps: UpdateCheckDeps,
  input: UpdateCheckInput,
): AsyncIterable<UpdateCheckEvent> {
  ctx.logger.debug`Checking for updates (checkOnly=${input.checkOnly})`;

  yield { kind: "checking" };

  const result = input.checkOnly
    ? await deps.check(input.platform)
    : await deps.update(input.platform);

  yield { kind: "completed", data: result };
}
