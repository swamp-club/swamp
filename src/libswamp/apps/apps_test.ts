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
import type { InstalledApp } from "../../domain/apps/app_catalog.ts";
import { capabilityKey } from "../../domain/apps/app_descriptor.ts";
import type { AppLaunchKey } from "../../domain/apps/app_launch.ts";
import { createLibSwampContext } from "../context.ts";
import { consumeStream } from "../stream.ts";
import {
  appApprove,
  type AppDeps,
  appLaunch,
  type AppLaunchData,
  appRevoke,
} from "./apps.ts";

const descriptor = {
  name: "@acme/cost",
  title: "Cost",
  entry: "dist/index.html",
  bridge: 1 as const,
  platform: 1,
  capabilities: [],
  run: [],
  methods: [],
};

const launchKey: AppLaunchKey = {
  signing: () => Promise.resolve(new Uint8Array(32)),
  verifying: () => Promise.resolve(new Uint8Array(32)),
};

function deps(
  app: Partial<InstalledApp>,
  approved: boolean,
): AppDeps & { launchKey: AppLaunchKey } {
  return {
    catalog: {
      list: () =>
        Promise.resolve({
          apps: [{
            descriptor,
            root: "/app",
            origin: "local",
            built: true,
            ...app,
          }],
          problems: [],
        }),
    },
    approvals: {
      get: () =>
        Promise.resolve(
          approved
            ? {
              name: descriptor.name,
              capabilityKey: capabilityKey(descriptor, "local"),
              approvedBy: "user:a",
              approvedAt: "2026-11-04T00:00:00.000Z",
            }
            : null,
        ),
      save: () => Promise.resolve(),
      delete: () => Promise.resolve(false),
    },
    launchKey,
    now: () => new Date("2026-11-04T00:00:00.000Z"),
  };
}

async function launch(
  appDeps: AppDeps & { launchKey: AppLaunchKey },
): Promise<{ data?: AppLaunchData; failure?: string }> {
  const result: { data?: AppLaunchData; failure?: string } = {};
  await consumeStream(
    appLaunch(createLibSwampContext(), appDeps, { name: descriptor.name }),
    {
      completed: (e) => {
        result.data = e.data;
      },
      error: (e) => {
        result.failure = e.error.message;
      },
    },
  );
  return result;
}

Deno.test("appLaunch: a dev server opens without an approval or a launch", async () => {
  const { data } = await launch(
    deps({ devUrl: "http://127.0.0.1:5173/" }, false),
  );
  assertEquals(data?.url, "http://127.0.0.1:5173/");
});

Deno.test("appLaunch: an enabled app gets a path ending in its entry file", async () => {
  const { data } = await launch(deps({}, true));
  assert(/^\/app-files\/[^/]+\/index\.html$/.test(data?.url ?? ""));
});

Deno.test("appLaunch: an enabled app with no build says how to build it", async () => {
  const { failure } = await launch(deps({ built: false }, true));
  assert(failure?.includes("swamp app build"));
});

async function failureOf(
  events: AsyncIterable<
    { kind: "completed" } | { kind: "error"; error: { message: string } }
  >,
): Promise<string | null> {
  let failure: string | null = null;
  await consumeStream(events, {
    completed: () => {},
    error: (e) => {
      failure = e.error.message;
    },
  });
  return failure;
}

Deno.test("appRevoke: a name that is neither installed nor approved is not found", async () => {
  const failure = await failureOf(
    appRevoke(createLibSwampContext(), deps({}, false), {
      name: "@acme/csot",
    }),
  );
  assert(failure !== null && failure.includes("@acme/csot"));
});

Deno.test("appRevoke: an approval left by a removed app can still be cleared", async () => {
  const appDeps = deps({}, true);
  const failure = await failureOf(
    appRevoke(
      createLibSwampContext(),
      {
        ...appDeps,
        catalog: { list: () => Promise.resolve({ apps: [], problems: [] }) },
      },
      { name: descriptor.name },
    ),
  );
  assertEquals(failure, null);
});

Deno.test("appApprove: reports the key it approved", async () => {
  let key: string | undefined;
  await consumeStream(
    appApprove(createLibSwampContext(), deps({}, false), {
      name: descriptor.name,
      approvedBy: "user:a",
    }),
    {
      completed: (e) => {
        key = e.data.capabilityKey;
      },
      error: (e) => {
        throw new Error(e.error.message);
      },
    },
  );
  assertEquals(key, capabilityKey(descriptor, "local"));
});
