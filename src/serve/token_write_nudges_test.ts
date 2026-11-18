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

import { assertEquals } from "@std/assert";
import { EventBus } from "../domain/events/event_bus.ts";
import {
  createModelDataWritten,
  createModelUpdated,
} from "../domain/events/types.ts";
import { ENROLLMENT_TOKEN_MODEL_TYPE } from "../domain/models/worker/enrollment_token_model.ts";
import { subscribeTokenWriteNudges } from "./token_write_nudges.ts";

const TOKEN_TYPE = ENROLLMENT_TOKEN_MODEL_TYPE.normalized;
const versions = [{ name: "token-main", version: 2 }];

Deno.test("subscribeTokenWriteNudges: a workflow step or a method run writing a token nudges once each", async () => {
  const bus = new EventBus();
  let nudges = 0;
  subscribeTokenWriteNudges(bus, { nudge: () => nudges++ });

  await bus.publish(createModelDataWritten(TOKEN_TYPE, "id", "t", versions));
  await bus.publish(createModelUpdated(TOKEN_TYPE, "id", "t", versions));

  assertEquals(nudges, 2);
});

Deno.test("subscribeTokenWriteNudges: a write to another model type never nudges", async () => {
  const bus = new EventBus();
  let nudges = 0;
  subscribeTokenWriteNudges(bus, { nudge: () => nudges++ });

  await bus.publish(createModelDataWritten("swamp/grant", "id", "g", versions));
  await bus.publish(createModelUpdated("@acme/thing", "id", "x", versions));

  assertEquals(nudges, 0);
});

Deno.test("subscribeTokenWriteNudges: nothing nudges after unsubscribing", async () => {
  const bus = new EventBus();
  let nudges = 0;
  const unsubscribe = subscribeTokenWriteNudges(bus, {
    nudge: () => nudges++,
  });
  unsubscribe();

  await bus.publish(createModelDataWritten(TOKEN_TYPE, "id", "t", versions));
  await bus.publish(createModelUpdated(TOKEN_TYPE, "id", "t", versions));

  assertEquals(nudges, 0);
});
