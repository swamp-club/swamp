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
import { consumeStream, type IssueCreateEvent } from "../../libswamp/mod.ts";
import {
  createIssueCreateRenderer,
  renderExtensionRefusal,
  renderExtensionRepositoryHandoff,
} from "./issue_create.ts";
import type { RepositoryDispatchResult } from "../../cli/commands/extension_report_dispatcher.ts";

/** Captures console.log calls during `fn` and returns the concatenated output. */
async function captureConsoleLog(
  fn: () => Promise<void> | void,
): Promise<string> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines.join("\n");
}

async function* toStream(
  events: IssueCreateEvent[],
): AsyncGenerator<IssueCreateEvent> {
  for (const event of events) yield event;
}

Deno.test("issue_create renderer (log): extension-lab variant runs without error", async () => {
  const renderer = createIssueCreateRenderer("log");
  await consumeStream(
    toStream([
      {
        kind: "completed",
        data: {
          method: "extension-lab",
          number: 42,
          type: "bug",
          title: "t",
          serverUrl: "https://swamp-club.com",
          extensionName: "@swamp/aws",
        },
      },
    ]),
    renderer.handlers(),
  );
});

Deno.test("issue_create renderer (json): extension-lab variant serialises method + extensionName", async () => {
  const renderer = createIssueCreateRenderer("json");
  const out = await captureConsoleLog(async () => {
    await consumeStream(
      toStream([
        {
          kind: "completed",
          data: {
            method: "extension-lab",
            number: 42,
            type: "bug",
            title: "t",
            serverUrl: "https://swamp-club.com",
            extensionName: "@swamp/aws",
          },
        },
      ]),
      renderer.handlers(),
    );
  });
  const parsed = JSON.parse(out);
  assertEquals(parsed.method, "extension-lab");
  assertEquals(parsed.extensionName, "@swamp/aws");
  assertEquals(parsed.number, 42);
});

// ---- renderExtensionRefusal ----

Deno.test("renderExtensionRefusal (log): emits guidance lines, runs without error", () => {
  renderExtensionRefusal(
    {
      extensionName: "@adam/cfgmgmt",
      reason: "no-repository",
      guidance: "Line 1\nLine 2",
    },
    "log",
  );
});

Deno.test("renderExtensionRefusal (json): emits structured refusal payload", async () => {
  const out = await captureConsoleLog(() => {
    renderExtensionRefusal(
      {
        extensionName: "@adam/cfgmgmt",
        reason: "pvr-disabled",
        guidance: "Contact publisher",
      },
      "json",
    );
  });
  const parsed = JSON.parse(out);
  assertEquals(parsed.status, "refused");
  assertEquals(parsed.reason, "pvr-disabled");
  assertEquals(parsed.extensionName, "@adam/cfgmgmt");
  assertStringIncludes(parsed.guidance, "Contact publisher");
});

// ---- renderExtensionRepositoryHandoff ----

function handoffIssueGh(): RepositoryDispatchResult {
  return {
    kind: "handoff",
    method: "gh",
    variant: "issue",
    url: "https://github.com/adam/cfgmgmt/issues/42",
    number: 42,
    preparedTitle: "t",
    preparedBody: "b",
  };
}

function handoffAdvisoryBrowser(
  opts: Partial<Extract<RepositoryDispatchResult, { kind: "handoff" }>> = {},
): RepositoryDispatchResult {
  return {
    kind: "handoff",
    method: "browser",
    variant: "advisory",
    url: "https://github.com/adam/cfgmgmt/security/advisories/new",
    fallbackIssueUrl: "https://github.com/adam/cfgmgmt/issues/new?...",
    preparedTitle: "vuln",
    preparedBody: "body",
    ...opts,
  };
}

Deno.test("renderExtensionRepositoryHandoff (json): handoff issue via gh carries number + url", async () => {
  const out = await captureConsoleLog(() => {
    renderExtensionRepositoryHandoff(
      { result: handoffIssueGh(), extensionName: "@adam/cfgmgmt" },
      "json",
    );
  });
  const parsed = JSON.parse(out);
  assertEquals(parsed.status, "handoff");
  assertEquals(parsed.method, "gh");
  assertEquals(parsed.variant, "issue");
  assertEquals(parsed.number, 42);
  assertStringIncludes(parsed.url, "issues/42");
});

Deno.test("renderExtensionRepositoryHandoff (json): advisory variant includes fallbackIssueUrl", async () => {
  const out = await captureConsoleLog(() => {
    renderExtensionRepositoryHandoff(
      { result: handoffAdvisoryBrowser(), extensionName: "@adam/cfgmgmt" },
      "json",
    );
  });
  const parsed = JSON.parse(out);
  assertEquals(parsed.variant, "advisory");
  assertStringIncludes(parsed.fallbackIssueUrl, "issues/new");
});

Deno.test("renderExtensionRepositoryHandoff (json): embeds preparedTitle and preparedBody", async () => {
  const out = await captureConsoleLog(() => {
    renderExtensionRepositoryHandoff(
      { result: handoffIssueGh(), extensionName: "@adam/cfgmgmt" },
      "json",
    );
  });
  const parsed = JSON.parse(out);
  assertEquals(parsed.preparedTitle, "t");
  assertEquals(parsed.preparedBody, "b");
});

Deno.test("renderExtensionRepositoryHandoff (json): pvrCheckFailed flag surfaces", async () => {
  const out = await captureConsoleLog(() => {
    renderExtensionRepositoryHandoff(
      {
        result: handoffAdvisoryBrowser({ pvrCheckFailed: true }),
        extensionName: "@adam/cfgmgmt",
      },
      "json",
    );
  });
  const parsed = JSON.parse(out);
  assertEquals(parsed.pvrCheckFailed, true);
});

Deno.test("renderExtensionRepositoryHandoff (log): advisory runs without error", () => {
  renderExtensionRepositoryHandoff(
    {
      result: handoffAdvisoryBrowser(),
      extensionName: "@adam/cfgmgmt",
    },
    "log",
  );
});

Deno.test("renderExtensionRepositoryHandoff (json): refused result delegates to refusal renderer", async () => {
  const out = await captureConsoleLog(() => {
    renderExtensionRepositoryHandoff(
      {
        result: {
          kind: "refused",
          reason: "pvr-disabled",
          guidance: "no go",
        },
        extensionName: "@adam/cfgmgmt",
      },
      "json",
    );
  });
  const parsed = JSON.parse(out);
  assertEquals(parsed.status, "refused");
  assertEquals(parsed.reason, "pvr-disabled");
});
