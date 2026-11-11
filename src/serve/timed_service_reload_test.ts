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

import { assertEquals, assertRejects } from "@std/assert";
import {
  timedServiceFollowUp,
  type TimedServiceSlot,
} from "./timed_service_reload.ts";

interface FakeService {
  readonly id: number;
  started: boolean;
  stopped: boolean;
}

function slot(
  initial: FakeService | null,
  overrides: Partial<TimedServiceSlot<FakeService>> = {},
) {
  let current = initial;
  let built = 0;
  let closed = false;
  const value: TimedServiceSlot<FakeService> = {
    name: "token GC",
    settings: ["tokenGcInterval"],
    get: () => current,
    set: (service) => current = service,
    build: () => ({ id: ++built, started: false, stopped: false }),
    start: (service) => service.started = true,
    stop: (service) => {
      service.stopped = true;
      return Promise.resolve();
    },
    closed: () => closed,
    ...overrides,
  };
  return {
    slot: value,
    current: () => current,
    built: () => built,
    close: () => closed = true,
  };
}

Deno.test("timedServiceFollowUp: an interval moved off 0 builds and starts the service", async () => {
  const h = slot(null);
  const followUp = timedServiceFollowUp(h.slot, true);
  assertEquals(followUp?.name, "Starting token GC");
  assertEquals(followUp?.settings, ["tokenGcInterval"]);
  await followUp!.run();
  assertEquals(h.current()?.started, true);
});

Deno.test("timedServiceFollowUp: an interval moved to 0 stops and clears the running service", async () => {
  const running = { id: 0, started: true, stopped: false };
  const h = slot(running);
  const followUp = timedServiceFollowUp(h.slot, false);
  assertEquals(followUp?.name, "Stopping token GC");
  assertEquals(h.current(), running);
  await followUp!.run();
  assertEquals(h.current(), null);
  assertEquals(running.stopped, true);
});

Deno.test("timedServiceFollowUp: a service already in the wanted state needs no follow-up", () => {
  assertEquals(timedServiceFollowUp(slot(null).slot, false), undefined);
  assertEquals(
    timedServiceFollowUp(
      slot({ id: 0, started: true, stopped: false }).slot,
      true,
    ),
    undefined,
  );
});

Deno.test("timedServiceFollowUp: after shutdown began nothing is built", async () => {
  const h = slot(null);
  const followUp = timedServiceFollowUp(h.slot, true);
  h.close();
  await followUp!.run();
  assertEquals(h.built(), 0);
  assertEquals(h.current(), null);
});

Deno.test("timedServiceFollowUp: a build that resolves after shutdown began is stopped, not started", async () => {
  const release = Promise.withResolvers<FakeService>();
  const h = slot(null, { build: () => release.promise });
  const followUp = timedServiceFollowUp(h.slot, true);
  const running = followUp!.run();
  h.close();
  const service = { id: 1, started: false, stopped: false };
  release.resolve(service);
  await running;
  assertEquals(service.started, false);
  assertEquals(service.stopped, true);
  assertEquals(h.current(), null);
});

Deno.test("timedServiceFollowUp: a failed build rejects, so the setting is reported as not landed", async () => {
  const h = slot(null, {
    build: () => {
      throw new Error("serve is still starting");
    },
  });
  await assertRejects(
    () => timedServiceFollowUp(h.slot, true)!.run(),
    Error,
    "serve is still starting",
  );
  assertEquals(h.current(), null);
});

Deno.test("timedServiceFollowUp: a stop in flight keeps the service in its slot, so shutdown still waits on it", async () => {
  const running = { id: 0, started: true, stopped: false };
  const stopping = Promise.withResolvers<void>();
  const h = slot(running, { stop: () => stopping.promise });
  const stop = timedServiceFollowUp(h.slot, false)!.run();
  assertEquals(h.current(), running);
  stopping.resolve();
  await stop;
  assertEquals(h.current(), null);
});
