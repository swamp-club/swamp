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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { waitFor } from "@swamp-club/swamp-testing";
import { UserError } from "../../domain/errors.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import {
  listeningUrl,
  readHostYaml,
  serveUntilStopped,
  type StopSignals,
} from "./serve_host.ts";

await initializeLogging({});

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  try {
    await fn(tempDir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
}

class FakeSignals implements StopSignals {
  readonly events: string[] = [];
  #listener: (() => void) | null = null;

  onStop(listener: () => void): () => void {
    this.#listener = listener;
    this.events.push("registered");
    return () => {
      this.#listener = null;
      this.events.push("unregistered");
    };
  }

  /** true when a listener was still registered to hear it */
  send(): boolean {
    if (this.#listener === null) return false;
    this.#listener();
    return true;
  }
}

class FakeHost {
  readonly events: string[];
  readonly #finished = Promise.withResolvers<void>();
  readonly #drained = Promise.withResolvers<void>();
  readonly finished = this.#finished.promise;
  shutdowns = 0;

  constructor(events: string[]) {
    this.events = events;
  }

  shutdown(): Promise<void> {
    this.shutdowns++;
    this.events.push("shutdown started");
    return this.#drained.promise.then(() => {
      this.events.push("shutdown finished");
    });
  }

  drain(): void {
    this.#drained.resolve();
  }

  finish(): void {
    this.#finished.resolve();
  }
}

Deno.test("listeningUrl: brackets an IPv6 listener and leaves the rest as they are", () => {
  assertEquals(listeningUrl("http", "::1", 8080), "http://[::1]:8080");
  assertEquals(listeningUrl("https", "0.0.0.0", 443), "https://0.0.0.0:443");
  assertEquals(listeningUrl("http", "localhost", 80), "http://localhost:80");
  assertEquals(
    new URL(listeningUrl("https", "fe80::1", 8443)).port,
    "8443",
  );
});

Deno.test("readHostYaml: reads host.yaml from the host folder", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(join(dir, "host.yaml"), "address: http://a\n");
    assertEquals(await readHostYaml(dir), "address: http://a\n");
  });
});

Deno.test("readHostYaml: a folder without host.yaml points at --host-dir", async () => {
  await withTempDir(async (dir) => {
    const error = await assertRejects(() => readHostYaml(dir), UserError);
    assertStringIncludes(error.message, "No host.yaml in");
    assertStringIncludes(error.message, "--host-dir");
  });
});

Deno.test("readHostYaml: a host.yaml that cannot be read says so", async () => {
  await withTempDir(async (dir) => {
    await Deno.mkdir(join(dir, "host.yaml"));
    const error = await assertRejects(() => readHostYaml(dir), UserError);
    assertStringIncludes(error.message, "Cannot read");
  });
});

Deno.test("serveUntilStopped: a stop request drains the host before the signals are let go", async () => {
  const signals = new FakeSignals();
  const host = new FakeHost(signals.events);
  const serving = serveUntilStopped(host, signals);
  assertEquals(signals.send(), true);
  await waitFor(
    () => signals.events.includes("shutdown started"),
    "the drain to start",
  );
  assertEquals(
    signals.send(),
    true,
    "a second stop during the drain still reaches a listener",
  );
  host.drain();
  await serving;
  assertEquals(host.shutdowns, 1);
  assertEquals(signals.events, [
    "registered",
    "shutdown started",
    "shutdown finished",
    "unregistered",
  ]);
});

Deno.test("serveUntilStopped: a host whose listener ends on its own is still shut down", async () => {
  const signals = new FakeSignals();
  const host = new FakeHost(signals.events);
  host.drain();
  const serving = serveUntilStopped(host, signals);
  host.finish();
  await serving;
  assertEquals(host.shutdowns, 1);
  assertEquals(signals.events.at(-1), "unregistered");
});
