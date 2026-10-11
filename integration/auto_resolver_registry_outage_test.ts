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
import {
  type AutoResolveOutputPort,
  ExtensionAutoResolver,
  type ExtensionInstallerPort,
} from "../src/domain/extensions/extension_auto_resolver.ts";
import { ExtensionApiClient } from "../src/infrastructure/http/extension_api_client.ts";

// Regression guard for swamp-club#3243: a registry that cannot answer during
// auto-resolution (timeout, 5xx, rate limit) must be reported as a network
// error with the client's message, not as "no extension publishes this type".
// The bug was a contract mismatch between the HTTP client's errors and the
// resolver's classification, so this wires the real client into the real
// resolver the way src/cli/mod.ts does, with only fetch replaced.

const TYPE = "@swamp/s3-datastore";

/** Output port that records the events the resolver emits. */
function recordingOutput(): AutoResolveOutputPort & { events: string[] } {
  const events: string[] = [];
  const record = (event: string) => () => {
    events.push(event);
  };
  return {
    events,
    searching: record("searching"),
    installing: record("installing"),
    installed: record("installed"),
    notFound: record("notFound"),
    networkError(_type: string, error: string) {
      events.push(`networkError: ${error}`);
    },
    alreadyInstalledButFailed: record("alreadyInstalledButFailed"),
    installedWithoutType: record("installedWithoutType"),
    alreadyInstalledTruncated: record("alreadyInstalledTruncated"),
    legacyInstallation: record("legacyInstallation"),
    collectiveNotTrusted: record("collectiveNotTrusted"),
    localSourceFailed: record("localSourceFailed"),
    noStableVersion: record("noStableVersion"),
  };
}

/** Installer that must never be reached: every lookup here finds nothing. */
const unreachableInstaller: ExtensionInstallerPort = {
  inspectInstallation: () => Promise.reject(new Error("unexpected inspect")),
  install: () => Promise.reject(new Error("unexpected install")),
  hotLoadModels: () => Promise.resolve(0),
  hotLoadVaults: () => Promise.resolve(),
  hotLoadDatastores: () => Promise.resolve(),
  hotLoadWebhooks: () => Promise.resolve(),
  failedLocalSourceMatchesType: () => false,
  withInstallLock: (fn) => fn(),
  providesType: () => Promise.resolve(false),
};

/** Resolves {@link TYPE} against a registry whose every answer is `fetch`. */
async function resolveAgainst(
  fetch: (url: string | URL) => Promise<Response>,
): Promise<string[]> {
  const client = new ExtensionApiClient("http://registry.test", {}, {
    sleep: () => Promise.resolve(),
    fetch,
  });
  const output = recordingOutput();
  const resolver = new ExtensionAutoResolver({
    allowedCollectives: ["swamp"],
    extensionLookup: {
      getExtension: (name) => client.getExtension(name),
      searchExtensions: (params) => client.searchExtensions(params),
      getLatestVersionDetail: (name) => client.getLatestVersionDetail(name),
    },
    extensionInstaller: unreachableInstaller,
    output,
  });
  assertEquals(await resolver.resolve(TYPE), false);
  return output.events;
}

Deno.test("integration: auto-resolver reports a registry timeout as a network error", async () => {
  const events = await resolveAgainst(() =>
    Promise.reject(new DOMException("Signal timed out.", "TimeoutError"))
  );
  assertEquals(events, [
    "searching",
    "networkError: Request to http://registry.test timed out. Is the server running?",
  ]);
});

Deno.test("integration: auto-resolver reports a registry 5xx as a network error", async () => {
  const events = await resolveAgainst(() =>
    Promise.resolve(Response.json({ error: "upstream unavailable" }, {
      status: 503,
    }))
  );
  assertEquals(events, [
    "searching",
    "networkError: Extension API error (HTTP 503): upstream unavailable",
  ]);
});

Deno.test("integration: auto-resolver reports an exhausted rate limit as a network error", async () => {
  const events = await resolveAgainst(() =>
    Promise.resolve(
      new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "0" },
      }),
    )
  );
  assertEquals(events.length, 2);
  assertEquals(events[0], "searching");
  assertEquals(
    events[1].startsWith("networkError: Rate limit exceeded."),
    true,
  );
});

Deno.test("integration: auto-resolver reports not-found only when the registry answers empty", async () => {
  const events = await resolveAgainst((url) =>
    Promise.resolve(
      new URL(url).pathname === "/api/v1/extensions/search"
        ? Response.json({ extensions: [], total: 0 })
        : Response.json({ error: "not found" }, { status: 404 }),
    )
  );
  assertEquals(events, ["searching", "notFound"]);
});
