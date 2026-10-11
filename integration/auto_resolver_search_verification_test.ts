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

// Regression guard for swamp-club#3246: auto-resolution installed the first
// registry search hit for a type without checking that it provides the type,
// so a made-up type or a typo installed an unrelated extension and wrote it to
// the lockfile. This wires the real client into the real resolver the way
// src/cli/mod.ts does, with only fetch replaced, so the check reads the
// registry's own /latest response shape.

const VERSION = "2026.09.29.1";

/** Output port that records the events the resolver emits. */
function recordingOutput(): AutoResolveOutputPort & { events: string[] } {
  const events: string[] = [];
  const record = (event: string) => (extension?: unknown) => {
    events.push(
      typeof extension === "string" ? `${event}:${extension}` : event,
    );
  };
  return {
    events,
    searching: () => events.push("searching"),
    installing: record("installing"),
    installed: record("installed"),
    notFound: () => events.push("notFound"),
    networkError: () => events.push("networkError"),
    alreadyInstalledButFailed: record("alreadyInstalledButFailed"),
    installedWithoutType: record("installedWithoutType"),
    alreadyInstalledTruncated: record("alreadyInstalledTruncated"),
    legacyInstallation: record("legacyInstallation"),
    collectiveNotTrusted: record("collectiveNotTrusted"),
    localSourceFailed: record("localSourceFailed"),
    noStableVersion: record("noStableVersion"),
  };
}

/** Installer that records installs; an install provides the requested type. */
function recordingInstaller(): ExtensionInstallerPort & { installs: string[] } {
  const installs: string[] = [];
  return {
    installs,
    inspectInstallation: () => Promise.resolve({ state: "missing" }),
    install: (name) => {
      installs.push(name);
      return Promise.resolve({ version: VERSION });
    },
    hotLoadModels: () => Promise.resolve(1),
    hotLoadVaults: () => Promise.resolve(),
    hotLoadDatastores: () => Promise.resolve(),
    hotLoadWebhooks: () => Promise.resolve(),
    failedLocalSourceMatchesType: () => false,
    withInstallLock: (fn) => fn(),
    providesType: () => Promise.resolve(installs.length > 0),
  };
}

/**
 * A registry with no extension named after the type, whose search returns
 * `hits` in rank order; each hit's latest version publishes the model types
 * listed for it.
 */
function registry(
  hits: Record<string, string[]>,
): (url: string | URL) => Promise<Response> {
  return (url) => {
    const { pathname } = new URL(url);
    if (pathname === "/api/v1/extensions/search") {
      return Promise.resolve(Response.json({
        extensions: Object.keys(hits).map((name) => ({ name })),
        meta: { total: Object.keys(hits).length, page: 1, perPage: 5 },
      }));
    }
    const name = decodeURIComponent(
      pathname.replace("/api/v1/extensions/", "").replace(/\/latest$/, ""),
    );
    const types = hits[name];
    if (!types) {
      return Promise.resolve(Response.json({ error: "not found" }, {
        status: 404,
      }));
    }
    const latestVersionDetail = {
      version: VERSION,
      publishedAt: "2026-09-29T00:00:00Z",
      models: types.map((type) => ({ fileName: "m.ts", type })),
      vaults: [],
      datastores: [],
      drivers: [],
    };
    return Promise.resolve(Response.json({
      name,
      description: name,
      latestVersion: VERSION,
      latestVersionDetail,
    }));
  };
}

async function resolveAgainst(
  type: string,
  hits: Record<string, string[]>,
): Promise<{ resolved: boolean; events: string[]; installs: string[] }> {
  const client = new ExtensionApiClient("http://registry.test", {}, {
    sleep: () => Promise.resolve(),
    fetch: registry(hits),
  });
  const output = recordingOutput();
  const installer = recordingInstaller();
  const resolver = new ExtensionAutoResolver({
    allowedCollectives: ["swamp"],
    extensionLookup: {
      getExtension: (name) => client.getExtension(name),
      searchExtensions: (params) => client.searchExtensions(params),
      getLatestVersionDetail: (name) => client.getLatestVersionDetail(name),
    },
    extensionInstaller: installer,
    output,
  });
  const resolved = await resolver.resolve(type);
  return { resolved, events: output.events, installs: installer.installs };
}

Deno.test("integration: auto-resolver installs nothing when no search hit provides the type", async () => {
  const result = await resolveAgainst("@swamp/definitely-not-a-real-type", {
    "@swamp/gcp/realtimebidding": ["@swamp/gcp/realtimebidding/bidders"],
  });
  assertEquals(result, {
    resolved: false,
    events: ["searching", "notFound"],
    installs: [],
  });
});

Deno.test("integration: auto-resolver installs the search hit that provides the type", async () => {
  const result = await resolveAgainst("@swamp/azure-firewall", {
    "@swamp/opnsense-firewall": ["@swamp/opnsense-firewall"],
    "@swamp/azure": ["@swamp/azure-vnet", "@swamp/azure-firewall"],
  });
  assertEquals(result, {
    resolved: true,
    events: [
      "searching",
      "installing:@swamp/azure",
      "installed:@swamp/azure",
    ],
    installs: ["@swamp/azure"],
  });
});
