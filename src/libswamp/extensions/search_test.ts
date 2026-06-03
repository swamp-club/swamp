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
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  extensionSearch,
  type ExtensionSearchDeps,
  type ExtensionSearchEvent,
} from "./search.ts";

function makeDeps(
  overrides?: Partial<ExtensionSearchDeps>,
): ExtensionSearchDeps {
  return {
    searchExtensions: () =>
      Promise.resolve({
        extensions: [
          {
            name: "@ns/aws-ec2",
            description: "AWS EC2 model",
            latestVersion: "1.0.0",
            platforms: ["aws"],
            labels: ["compute"],
            contentTypes: ["models"],
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-02T00:00:00Z",
          },
          {
            name: "@ns/aws-s3",
            description: "AWS S3 model",
            latestVersion: "2.0.0",
            platforms: ["aws"],
            labels: ["storage"],
            contentTypes: ["models"],
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-03T00:00:00Z",
          },
        ],
        meta: { total: 2, page: 1, perPage: 20 },
      }),
    ...overrides,
  };
}

Deno.test("extensionSearch: returns results from API", async () => {
  const events = await collect<ExtensionSearchEvent>(
    extensionSearch(createLibSwampContext(), makeDeps(), { query: "aws" }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });

  const completed = events[1] as Extract<
    ExtensionSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.query, "aws");
  assertEquals(completed.data.results.length, 2);
  assertEquals(completed.data.results[0].name, "@ns/aws-ec2");
  assertEquals(completed.data.results[1].name, "@ns/aws-s3");
  assertEquals(completed.data.meta.total, 2);
  assertEquals(completed.data.meta.page, 1);
  assertEquals(completed.data.meta.perPage, 20);
});

Deno.test("extensionSearch: passes query and params through", async () => {
  let capturedParams:
    | {
      q?: string;
      collective?: string;
      platform?: string[];
      label?: string[];
      contentType?: string[];
      sort?: string;
      perPage?: number;
      page?: number;
    }
    | undefined;

  const deps = makeDeps({
    searchExtensions: (params) => {
      capturedParams = params;
      return Promise.resolve({
        extensions: [],
        meta: { total: 0, page: 1, perPage: 10 },
      });
    },
  });

  await collect<ExtensionSearchEvent>(
    extensionSearch(
      createLibSwampContext(),
      deps,
      {
        query: "networking",
        collective: "stack72",
        platform: ["aws"],
        label: ["vpc"],
        contentType: ["models"],
        sort: "new",
        perPage: 10,
        page: 2,
      },
    ),
  );

  assertEquals(capturedParams?.q, "networking");
  assertEquals(capturedParams?.collective, "stack72");
  assertEquals(capturedParams?.platform, ["aws"]);
  assertEquals(capturedParams?.label, ["vpc"]);
  assertEquals(capturedParams?.contentType, ["models"]);
  assertEquals(capturedParams?.sort, "new");
  assertEquals(capturedParams?.perPage, 10);
  assertEquals(capturedParams?.page, 2);
});

Deno.test("extensionSearch: empty results", async () => {
  const deps = makeDeps({
    searchExtensions: () =>
      Promise.resolve({
        extensions: [],
        meta: { total: 0, page: 1, perPage: 20 },
      }),
  });

  const events = await collect<ExtensionSearchEvent>(
    extensionSearch(createLibSwampContext(), deps, {}),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });

  const completed = events[1] as Extract<
    ExtensionSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.query, "");
  assertEquals(completed.data.results.length, 0);
  assertEquals(completed.data.meta.total, 0);
});
