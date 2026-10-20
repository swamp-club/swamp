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
import { hostname } from "node:os";
import {
  type AutoResolveOutputPort,
  ExtensionAutoResolver,
  type ExtensionInstallerPort,
  type InstallLockHolder,
} from "../src/domain/extensions/extension_auto_resolver.ts";
import { FileLock } from "../src/infrastructure/persistence/file_lock.ts";

// swamp-club#3656: when another process holds the install lock for longer
// than this one waits, auto-resolution reports which process is installing
// rather than a type that is not registered. A real FileLock is held, so the
// holder comes from the lock file the way it does across processes.

const TYPE = "@swamp/gcs-datastore";
const LOCK_KEY = ".extension-install.lock";

interface BusyEvent {
  type: string;
  extension: string;
  holder: InstallLockHolder | null;
}

function recordingOutput(): AutoResolveOutputPort & {
  busy: BusyEvent[];
  events: string[];
} {
  const busy: BusyEvent[] = [];
  const events: string[] = [];
  const record = (event: string) => () => {
    events.push(event);
  };
  return {
    busy,
    events,
    searching: record("searching"),
    installing: record("installing"),
    installed: record("installed"),
    notFound: record("notFound"),
    networkError: record("networkError"),
    alreadyInstalledButFailed: record("alreadyInstalledButFailed"),
    installedWithoutType: record("installedWithoutType"),
    alreadyInstalledTruncated: record("alreadyInstalledTruncated"),
    legacyInstallation: record("legacyInstallation"),
    collectiveNotTrusted: record("collectiveNotTrusted"),
    localSourceFailed: record("localSourceFailed"),
    noStableVersion: record("noStableVersion"),
    installBusy(type, extension, holder) {
      events.push("installBusy");
      busy.push({ type, extension, holder });
    },
  };
}

/** Installer whose lock is a real FileLock that gives up after a moment. */
function installerWaitingOn(dir: string): ExtensionInstallerPort {
  const unexpected = () => Promise.reject(new Error("unexpected call"));
  return {
    inspectInstallation: unexpected,
    install: unexpected,
    hotLoadModels: () => Promise.resolve(0),
    hotLoadVaults: () => Promise.resolve(),
    hotLoadDatastores: () => Promise.resolve(),
    hotLoadWebhooks: () => Promise.resolve(),
    failedLocalSourceMatchesType: () => false,
    providesType: () => Promise.resolve(false),
    async withInstallLock<T>(fn: () => Promise<T>): Promise<T> {
      const lock = new FileLock(dir, {
        lockKey: LOCK_KEY,
        maxWaitMs: 200,
        retryIntervalMs: 20,
      });
      await lock.acquire();
      try {
        return await fn();
      } finally {
        await lock.release();
      }
    },
  };
}

Deno.test("integration: auto-resolver names the process holding the install lock", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_3656_busy_" });
  const held = new FileLock(dir, { lockKey: LOCK_KEY });
  await held.acquire();
  try {
    const output = recordingOutput();
    const resolver = new ExtensionAutoResolver({
      allowedCollectives: ["swamp"],
      extensionLookup: {
        getExtension: (name) =>
          Promise.resolve({
            name,
            description: "GCS datastore",
            latestVersion: "2026.10.20.1",
          }),
        searchExtensions: () => Promise.resolve({ extensions: [], total: 0 }),
      },
      extensionInstaller: installerWaitingOn(dir),
      output,
    });

    assertEquals(await resolver.resolve(TYPE), false);
    assertEquals(output.events, ["searching", "installBusy"]);
    const [event] = output.busy;
    assertEquals(event.type, TYPE);
    assertEquals(event.extension, TYPE);
    assertEquals(event.holder?.pid, Deno.pid);
    assertEquals(event.holder?.hostname, hostname());
  } finally {
    await held.release();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
