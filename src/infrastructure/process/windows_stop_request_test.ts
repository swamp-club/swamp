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

import { assert, assertEquals } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import { sendGracefulStop } from "./process_kill.ts";
import {
  createStopRequestListener,
  EVENT_MODIFY_STATE,
  type Kernel32Events,
  listenForStopRequests,
  loadKernel32Events,
  type PollScheduler,
  requestStop,
  sendStopRequest,
  stopRequestEventName,
  type StopRequestListener,
  WAIT_OBJECT_0,
  wideString,
} from "./windows_stop_request.ts";

const WAIT_TIMEOUT = 0x102;

function decodeWide(name: BufferSource): string {
  const bytes = ArrayBuffer.isView(name)
    ? new Uint8Array(name.buffer, name.byteOffset, name.byteLength)
    : new Uint8Array(name);
  const units = new Uint16Array(bytes.slice().buffer);
  assertEquals(units[units.length - 1], 0, "name is NUL-terminated");
  return String.fromCharCode(...units.subarray(0, units.length - 1));
}

/**
 * A fake kernel32 holding named auto-reset events, as Windows does: a
 * create of an existing name opens it, an event lives until its last handle
 * closes. `fail` names calls that fail.
 */
function fakeKernel32(fail: ReadonlySet<string> = new Set()) {
  const calls: string[] = [];
  const events = new Map<string, { signalled: boolean; handles: number }>();
  const handles = new Map<bigint, string>();
  let nextHandle = 0x100n;

  function newHandle(name: string): Deno.PointerValue {
    const address = nextHandle++;
    handles.set(address, name);
    events.get(name)!.handles++;
    return Deno.UnsafePointer.create(address);
  }
  function nameOf(handle: Deno.PointerValue): string {
    if (handle === null) return "null";
    return handles.get(Deno.UnsafePointer.value(handle)) ?? "unknown";
  }

  const kernel32: Kernel32Events = {
    CreateEventW: (_attributes, manualReset, initialState, name) => {
      const text = decodeWide(name);
      calls.push(`CreateEventW ${manualReset} ${initialState} ${text}`);
      if (fail.has("CreateEventW")) return null;
      if (!events.has(text)) events.set(text, { signalled: false, handles: 0 });
      return newHandle(text);
    },
    OpenEventW: (access, inherit, name) => {
      const text = decodeWide(name);
      calls.push(`OpenEventW 0x${access.toString(16)} ${inherit} ${text}`);
      if (!events.has(text)) return null;
      return newHandle(text);
    },
    SetEvent: (event) => {
      calls.push(`SetEvent ${nameOf(event)}`);
      if (fail.has("SetEvent")) return 0;
      events.get(nameOf(event))!.signalled = true;
      return 1;
    },
    WaitForSingleObject: (handle, milliseconds) => {
      calls.push(`WaitForSingleObject ${nameOf(handle)} ${milliseconds}`);
      const event = events.get(nameOf(handle))!;
      if (!event.signalled) return WAIT_TIMEOUT;
      event.signalled = false;
      return WAIT_OBJECT_0;
    },
    CloseHandle: (handle) => {
      const name = nameOf(handle);
      calls.push(`CloseHandle ${name}`);
      handles.delete(Deno.UnsafePointer.value(handle!));
      const event = events.get(name)!;
      if (--event.handles === 0) events.delete(name);
      return 1;
    },
  };
  return { kernel32, calls, events };
}

/** A scheduler whose polls run only when the test ticks it. */
function manualScheduler() {
  let poll: (() => void) | undefined;
  const scheduler: PollScheduler = {
    start(next) {
      assertEquals(poll, undefined, "one poll at a time");
      poll = next;
      return () => {
        poll = undefined;
      };
    },
  };
  return {
    scheduler,
    tick: () => poll?.(),
    polling: () => poll !== undefined,
  };
}

const NAME = "Local\\swamp-stop-4242";

function listenerFor(kernel32: Kernel32Events) {
  const poller = manualScheduler();
  const listener = createStopRequestListener(
    () => kernel32,
    4242,
    poller.scheduler,
  );
  return { listener, ...poller };
}

Deno.test("stopRequestEventName: names the pid's event in the session namespace", () => {
  assertEquals(stopRequestEventName(4242), NAME);
  assertEquals([...wideString("ab")], [0x61, 0x62, 0]);
});

Deno.test("createStopRequestListener: the first subscription creates and drains the pid's event, then polls it", () => {
  const { kernel32, calls } = fakeKernel32();
  const { listener, polling } = listenerFor(kernel32);

  assert(listener.subscribe(() => {}));

  assertEquals(calls, [
    `CreateEventW 0 0 ${NAME}`,
    `WaitForSingleObject ${NAME} 0`,
  ]);
  assert(polling());
});

Deno.test("createStopRequestListener: a stop request reaches every subscriber once", () => {
  const { kernel32 } = fakeKernel32();
  const { listener, tick } = listenerFor(kernel32);
  const heard: string[] = [];
  listener.subscribe(() => heard.push("a"));
  listener.subscribe(() => heard.push("b"));

  tick();
  assertEquals(heard, [], "nothing without a request");

  assert(sendStopRequest(kernel32, 4242));
  tick();
  tick();

  assertEquals(heard, ["a", "b"]);
});

Deno.test("createStopRequestListener: ending one subscription twice leaves the others listening", () => {
  const { kernel32, calls } = fakeKernel32();
  const { listener, tick, polling } = listenerFor(kernel32);
  const heard: string[] = [];
  const endA = listener.subscribe(() => heard.push("a"))!;
  const endB = listener.subscribe(() => heard.push("b"))!;

  endA();
  endA();
  assert(polling());
  assertEquals(calls.filter((call) => call.startsWith("CloseHandle")), []);

  sendStopRequest(kernel32, 4242);
  tick();
  assertEquals(heard, ["b"]);

  endB();
  assertEquals(calls.at(-1), `CloseHandle ${NAME}`);
  assertEquals(polling(), false);
});

Deno.test("createStopRequestListener: subscribing after the last subscription ended creates the event again", () => {
  const { kernel32, calls } = fakeKernel32();
  const { listener, tick } = listenerFor(kernel32);
  listener.subscribe(() => {})!();
  let heard = 0;

  listener.subscribe(() => heard++);
  sendStopRequest(kernel32, 4242);
  tick();

  assertEquals(
    calls.filter((call) => call.startsWith("CreateEventW")).length,
    2,
  );
  assertEquals(heard, 1);
});

Deno.test("createStopRequestListener: an event already set when created does not stop the process", () => {
  const { kernel32 } = fakeKernel32();
  // A sender still holds the event of a process that had this pid before.
  const previous = kernel32.CreateEventW(null, 0, 0, wideString(NAME));
  kernel32.SetEvent(previous);
  const { listener, tick } = listenerFor(kernel32);
  let heard = 0;

  listener.subscribe(() => heard++);
  tick();

  assertEquals(heard, 0);
});

Deno.test("createStopRequestListener: a failed create leaves nothing behind, and the next subscription retries", () => {
  const failing = fakeKernel32(new Set(["CreateEventW"]));
  const working = fakeKernel32();
  let kernel32 = failing.kernel32;
  const poller = manualScheduler();
  const listener = createStopRequestListener(
    () => kernel32,
    4242,
    poller.scheduler,
  );

  assertEquals(listener.subscribe(() => {}), undefined);
  assertEquals(poller.polling(), false);

  kernel32 = working.kernel32;
  let heard = 0;
  assert(listener.subscribe(() => heard++));
  sendStopRequest(working.kernel32, 4242);
  poller.tick();
  assertEquals(heard, 1);
});

Deno.test("createStopRequestListener: cannot listen when kernel32 is unavailable or throws", () => {
  const unavailable = createStopRequestListener(
    () => null,
    4242,
    manualScheduler().scheduler,
  );
  assertEquals(unavailable.subscribe(() => {}), undefined);

  const { kernel32 } = fakeKernel32();
  const poller = manualScheduler();
  const throwing = createStopRequestListener(
    () => ({
      ...kernel32,
      CreateEventW: () => {
        throw new Error("ffi failure");
      },
    }),
    4242,
    poller.scheduler,
  );
  assertEquals(throwing.subscribe(() => {}), undefined);
  assertEquals(poller.polling(), false);
});

Deno.test("createStopRequestListener: closes the event when polling cannot start", () => {
  const { kernel32, calls } = fakeKernel32();
  const listener = createStopRequestListener(() => kernel32, 4242, {
    start: () => {
      throw new Error("no timers");
    },
  });

  assertEquals(listener.subscribe(() => {}), undefined);

  assertEquals(calls.at(-1), `CloseHandle ${NAME}`);
});

Deno.test("sendStopRequest: sets the pid's event and closes its handle", () => {
  const { kernel32, calls } = fakeKernel32();
  const { listener } = listenerFor(kernel32);
  listener.subscribe(() => {});
  calls.length = 0;

  assertEquals(sendStopRequest(kernel32, 4242), true);

  assertEquals(calls, [
    `OpenEventW 0x${EVENT_MODIFY_STATE.toString(16)} 0 ${NAME}`,
    `SetEvent ${NAME}`,
    `CloseHandle ${NAME}`,
  ]);
});

Deno.test("sendStopRequest: reports false when no process listens under the pid", () => {
  const { kernel32, calls } = fakeKernel32();

  assertEquals(sendStopRequest(kernel32, 4242), false);

  assertEquals(calls, [`OpenEventW 0x2 0 ${NAME}`]);
});

Deno.test("sendStopRequest: reports false and still closes the handle when the event cannot be set", () => {
  const { kernel32, calls } = fakeKernel32(new Set(["SetEvent"]));
  kernel32.CreateEventW(null, 0, 0, wideString(NAME));
  calls.length = 0;

  assertEquals(sendStopRequest(kernel32, 4242), false);

  assertEquals(calls.at(-1), `CloseHandle ${NAME}`);
});

Deno.test("requestStop: sends nothing outside Windows", () => {
  let loaded = false;
  for (const os of ["darwin", "linux"] as const) {
    assertEquals(
      requestStop(4242, os, () => {
        loaded = true;
        return fakeKernel32().kernel32;
      }),
      false,
    );
  }
  assertEquals(loaded, false);
});

Deno.test("requestStop: reports false when kernel32 is unavailable or throws", () => {
  assertEquals(requestStop(4242, "windows", () => null), false);

  const { kernel32 } = fakeKernel32();
  const throwing: Kernel32Events = {
    ...kernel32,
    OpenEventW: () => {
      throw new Error("ffi failure");
    },
  };
  assertEquals(requestStop(4242, "windows", () => throwing), false);
});

Deno.test("requestStop: reaches a listening process on Windows", () => {
  const { kernel32 } = fakeKernel32();
  const { listener } = listenerFor(kernel32);
  listener.subscribe(() => {});

  assertEquals(requestStop(4242, "windows", () => kernel32), true);
});

Deno.test("listenForStopRequests: listens only on Windows", () => {
  const subscribed: string[] = [];
  const listener: StopRequestListener = {
    subscribe: () => {
      subscribed.push("subscribe");
      return () => {};
    },
  };

  for (const os of ["darwin", "linux"] as const) {
    assertEquals(
      listenForStopRequests(() => {}, os, () => listener),
      undefined,
    );
  }
  assertEquals(subscribed, []);

  assert(listenForStopRequests(() => {}, "windows", () => listener));
  assertEquals(subscribed, ["subscribe"]);
});

Deno.test("createStopRequestListener: a handler that throws does not keep the request from the others", () => {
  const { kernel32 } = fakeKernel32();
  const { listener, tick } = listenerFor(kernel32);
  const heard: string[] = [];
  listener.subscribe(() => {
    throw new Error("handler failure");
  });
  listener.subscribe(() => heard.push("b"));

  sendStopRequest(kernel32, 4242);
  tick();

  assertEquals(heard, ["b"]);
});

Deno.test({
  name:
    "stop requests: sendGracefulStop reaches a listener through kernel32 (Windows)",
  // The real event, created and set by name: what the run's owner and
  // workflow cancel each do (swamp-club#3267). Test files run in parallel in
  // one process, so they share Deno.pid; the event is named for a pid no
  // process has, so this test never reaches another file's listener.
  ignore: Deno.build.os !== "windows",
  fn: async () => {
    const pid = 2 ** 32 + parseInt(crypto.randomUUID().slice(0, 8), 16);
    let stops = 0;
    const end = createStopRequestListener(loadKernel32Events, pid).subscribe(
      () => {
        stops++;
      },
    );
    assert(end, "the listener creates its event");
    const kills: number[] = [];
    try {
      sendGracefulStop(pid, { kill: (target) => kills.push(target) });

      await waitFor(() => stops === 1, "stop request to reach the listener");
      assertEquals(kills, [], "no TerminateProcess fallback");
    } finally {
      end();
    }
    assertEquals(requestStop(pid), false, "nothing listens once it ended");
  },
});
