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

import { modelRegistry } from "../domain/models/model.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import { withExtensionMutation } from "./extension_reload.ts";

const logger = getSwampLogger(["serve", "local-model-refresh"]);

/**
 * Brings serve's model registry up to date with edited repo-local model
 * sources before a run resolves its models (swamp-club#3284), so both the
 * steps serve runs itself and the bundles it ships to workers carry the
 * current code. Takes its turn with a hot-reload. A failure is logged and
 * never fails the run: the run then resolves what is registered.
 */
export async function refreshLocalModelsForRun(): Promise<void> {
  try {
    await modelRegistry.refreshSources(withExtensionMutation);
  } catch (error) {
    logger.warn("Could not check local behaviors for edits: {error}", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
