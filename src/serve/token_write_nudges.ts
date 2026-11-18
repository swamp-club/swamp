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

import type { EventBus } from "../domain/events/event_bus.ts";
import type { ModelDataWritten, ModelUpdated } from "../domain/events/types.ts";
import { ENROLLMENT_TOKEN_MODEL_TYPE } from "../domain/models/worker/enrollment_token_model.ts";

/** a token this serve wrote is checked at once, not at the next pass */
export function subscribeTokenWriteNudges(
  eventBus: EventBus,
  revalidation: { nudge(): void },
): () => void {
  const onWrite = (event: ModelDataWritten | ModelUpdated) => {
    if (event.modelType === ENROLLMENT_TOKEN_MODEL_TYPE.normalized) {
      revalidation.nudge();
    }
  };
  const unsubscribers = [
    eventBus.subscribe<ModelDataWritten>("ModelDataWritten", onWrite),
    eventBus.subscribe<ModelUpdated>("ModelUpdated", onWrite),
  ];
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}
