// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  issueCreate,
  type IssueCreateDeps,
  type IssueCreateEvent,
} from "./create.ts";
import type { ReporterContext } from "../../domain/extensions/reporter_context.ts";

function makeDeps(overrides: Partial<IssueCreateDeps> = {}): IssueCreateDeps {
  return {
    submitToLab: () =>
      Promise.resolve({ number: 1, serverUrl: "https://swamp-club.com" }),
    ...overrides,
  };
}

const SAMPLE_CONTEXT: ReporterContext = {
  extensionName: "@swamp/aws",
  extensionVersion: "2026.04.22.1",
  swampVersion: "20260422.000000.0-sha.abc",
  os: "darwin",
  arch: "aarch64",
  shell: "/bin/zsh",
  denoVersion: "1.45.0",
};

Deno.test("issueCreate: submits bug to Lab and yields completed", async () => {
  const deps = makeDeps();

  const events = await collect<IssueCreateEvent>(
    issueCreate(createLibSwampContext(), deps, {
      title: "Test bug",
      body: "Test body",
      type: "bug",
    }),
  );

  assertEquals(events.length, 1);
  const completed = events[0] as Extract<
    IssueCreateEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.method, "lab");
  assertEquals(completed.data.title, "Test bug");
  assertEquals(completed.data.type, "bug");
});

Deno.test("issueCreate: submits feature to Lab", async () => {
  const deps = makeDeps({
    submitToLab: () =>
      Promise.resolve({ number: 7, serverUrl: "https://swamp-club.com" }),
  });

  const events = await collect<IssueCreateEvent>(
    issueCreate(createLibSwampContext(), deps, {
      title: "New feature",
      body: "Details",
      type: "feature",
    }),
  );

  assertEquals(events.length, 1);
  const completed = events[0] as Extract<
    IssueCreateEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.method, "lab");
  assertEquals((completed.data as { number: number }).number, 7);
  assertEquals(completed.data.type, "feature");
});

Deno.test("issueCreate: passes title, body, and type to submitToLab", async () => {
  let captured: { type: string; title: string; body: string } | undefined;
  const deps = makeDeps({
    submitToLab: (input) => {
      captured = input;
      return Promise.resolve({
        number: 42,
        serverUrl: "https://swamp-club.com",
      });
    },
  });

  await collect<IssueCreateEvent>(
    issueCreate(createLibSwampContext(), deps, {
      title: "My title",
      body: "My body",
      type: "bug",
    }),
  );

  assertEquals(captured?.type, "bug");
  assertEquals(captured?.title, "My title");
  assertEquals(captured?.body, "My body");
});

Deno.test("issueCreate: includes serverUrl in result", async () => {
  const deps = makeDeps({
    submitToLab: () =>
      Promise.resolve({
        number: 1,
        serverUrl: "https://custom.server.com",
      }),
  });

  const events = await collect<IssueCreateEvent>(
    issueCreate(createLibSwampContext(), deps, {
      title: "Test",
      body: "Body",
      type: "bug",
    }),
  );

  const data = (events[0] as Extract<IssueCreateEvent, { kind: "completed" }>)
    .data;
  if (data.method === "lab") {
    assertEquals(data.serverUrl, "https://custom.server.com");
  }
});

// ---- Regression: plain-lab request body is byte-identical ----

Deno.test("issueCreate: plain lab request body is byte-identical to caller body (regression)", async () => {
  let captured: { body: string } | undefined;
  const deps = makeDeps({
    submitToLab: (input) => {
      captured = { body: input.body };
      return Promise.resolve({
        number: 1,
        serverUrl: "https://swamp-club.com",
      });
    },
  });

  const userBody = "Hello\n\nA multi-line body\nwith trailing lines\n";
  await collect(issueCreate(createLibSwampContext(), deps, {
    title: "t",
    body: userBody,
    type: "bug",
  }));

  // Exact match — no trimming, no appending.
  assertEquals(captured?.body, userBody);
});

// ---- Extension-lab path ----

Deno.test("issueCreate: extension-lab variant set when extensionName present", async () => {
  const deps = makeDeps({
    submitToLab: () =>
      Promise.resolve({ number: 9, serverUrl: "https://swamp-club.com" }),
  });

  const events = await collect<IssueCreateEvent>(
    issueCreate(createLibSwampContext(), deps, {
      title: "t",
      body: "b",
      type: "bug",
      extensionName: "@swamp/aws",
      extensionVersion: "2026.04.22.1",
      reporterContext: SAMPLE_CONTEXT,
    }),
  );

  const data = (events[0] as Extract<IssueCreateEvent, { kind: "completed" }>)
    .data;
  assertEquals(data.method, "extension-lab");
  if (data.method === "extension-lab") {
    assertEquals(data.extensionName, "@swamp/aws");
    assertEquals(data.number, 9);
  }
});

Deno.test("issueCreate: extension body contains Extension: line", async () => {
  let captured: { body: string } | undefined;
  const deps = makeDeps({
    submitToLab: (input) => {
      captured = { body: input.body };
      return Promise.resolve({
        number: 1,
        serverUrl: "https://swamp-club.com",
      });
    },
  });

  await collect(issueCreate(createLibSwampContext(), deps, {
    title: "t",
    body: "b",
    type: "bug",
    extensionName: "@swamp/aws",
    extensionVersion: "2026.04.22.1",
    reporterContext: SAMPLE_CONTEXT,
  }));

  assertStringIncludes(
    captured?.body ?? "",
    "Extension: `@swamp/aws@2026.04.22.1`",
  );
});

Deno.test("issueCreate: extension body contains Upstream repository line when set", async () => {
  let captured: { body: string } | undefined;
  const deps = makeDeps({
    submitToLab: (input) => {
      captured = { body: input.body };
      return Promise.resolve({
        number: 1,
        serverUrl: "https://swamp-club.com",
      });
    },
  });

  await collect(issueCreate(createLibSwampContext(), deps, {
    title: "t",
    body: "b",
    type: "bug",
    extensionName: "@swamp/aws",
    extensionVersion: "2026.04.22.1",
    repositoryUrl: "https://github.com/systeminit/swamp-aws",
    reporterContext: SAMPLE_CONTEXT,
  }));

  assertStringIncludes(
    captured?.body ?? "",
    "Upstream repository: https://github.com/systeminit/swamp-aws",
  );
});

Deno.test("issueCreate: extension body omits Upstream repository when unset", async () => {
  let captured: { body: string } | undefined;
  const deps = makeDeps({
    submitToLab: (input) => {
      captured = { body: input.body };
      return Promise.resolve({
        number: 1,
        serverUrl: "https://swamp-club.com",
      });
    },
  });

  await collect(issueCreate(createLibSwampContext(), deps, {
    title: "t",
    body: "b",
    type: "bug",
    extensionName: "@swamp/aws",
    extensionVersion: "2026.04.22.1",
    reporterContext: SAMPLE_CONTEXT,
  }));

  const body = captured?.body ?? "";
  assertEquals(body.includes("Upstream repository:"), false);
});

Deno.test("issueCreate: extension body contains reporter-context Environment section", async () => {
  let captured: { body: string } | undefined;
  const deps = makeDeps({
    submitToLab: (input) => {
      captured = { body: input.body };
      return Promise.resolve({
        number: 1,
        serverUrl: "https://swamp-club.com",
      });
    },
  });

  await collect(issueCreate(createLibSwampContext(), deps, {
    title: "t",
    body: "b",
    type: "bug",
    extensionName: "@swamp/aws",
    extensionVersion: "2026.04.22.1",
    reporterContext: SAMPLE_CONTEXT,
  }));

  assertStringIncludes(captured?.body ?? "", "## Environment");
  assertStringIncludes(captured?.body ?? "", "darwin");
});

Deno.test("issueCreate: extension path does not modify title", async () => {
  let captured: { title: string } | undefined;
  const deps = makeDeps({
    submitToLab: (input) => {
      captured = { title: input.title };
      return Promise.resolve({
        number: 1,
        serverUrl: "https://swamp-club.com",
      });
    },
  });

  await collect(issueCreate(createLibSwampContext(), deps, {
    title: "Plain title",
    body: "b",
    type: "bug",
    extensionName: "@swamp/aws",
    extensionVersion: "2026.04.22.1",
    reporterContext: SAMPLE_CONTEXT,
  }));

  assertEquals(captured?.title, "Plain title");
});
