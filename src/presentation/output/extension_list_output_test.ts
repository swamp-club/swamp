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

import { assertEquals } from "@std/assert/equals";
import { assertStringIncludes } from "@std/assert/string-includes";
import { renderExtensionList } from "./extension_list_output.ts";

function captureConsoleLog(fn: () => void): string {
  const original = console.log;
  let captured = "";
  console.log = (msg: string) => {
    captured += msg;
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return captured;
}

Deno.test("renderExtensionList outputs valid JSON in json mode", () => {
  const output = captureConsoleLog(() => {
    renderExtensionList(
      {
        extensions: [
          {
            name: "@test/ext",
            version: "2026.01.01.1",
            pulledAt: "2026-01-01T00:00:00.000Z",
            files: ["extensions/models/ext/model.yaml"],
          },
        ],
      },
      "json",
      false,
    );
  });
  const parsed = JSON.parse(output);
  assertEquals(parsed.extensions.length, 1);
  assertEquals(parsed.extensions[0].name, "@test/ext");
  assertEquals(parsed.extensions[0].version, "2026.01.01.1");
  assertEquals(parsed.extensions[0].files.length, 1);
});

Deno.test("renderExtensionList outputs empty array in json mode when no extensions", () => {
  const output = captureConsoleLog(() => {
    renderExtensionList({ extensions: [] }, "json", false);
  });
  const parsed = JSON.parse(output);
  assertEquals(parsed.extensions, []);
});

Deno.test("renderExtensionList in log mode with empty list does not throw", () => {
  renderExtensionList({ extensions: [] }, "log", false);
});

Deno.test("renderExtensionList in log mode with extensions does not throw", () => {
  renderExtensionList(
    {
      extensions: [
        {
          name: "@test/alpha",
          version: "2026.01.01.1",
          pulledAt: "2026-01-01T00:00:00.000Z",
          files: ["extensions/models/alpha/model.yaml"],
        },
        {
          name: "@test/beta",
          version: "2026.02.01.1",
          pulledAt: "2026-02-01T00:00:00.000Z",
          files: [],
        },
      ],
    },
    "log",
    false,
  );
});

Deno.test("renderExtensionList in log mode verbose does not throw", () => {
  renderExtensionList(
    {
      extensions: [
        {
          name: "@test/ext",
          version: "2026.01.01.1",
          pulledAt: "2026-01-01T00:00:00.000Z",
          files: [
            "extensions/models/ext/model.yaml",
            "extensions/models/ext/handler.ts",
          ],
        },
      ],
    },
    "log",
    true,
  );
});

Deno.test("renderExtensionList json mode includes version without v prefix", () => {
  const output = captureConsoleLog(() => {
    renderExtensionList(
      {
        extensions: [
          {
            name: "@test/ext",
            version: "2026.01.01.1",
            pulledAt: "2026-01-01T00:00:00.000Z",
            files: [],
          },
        ],
      },
      "json",
      false,
    );
  });
  const parsed = JSON.parse(output);
  assertEquals(parsed.extensions[0].version, "2026.01.01.1");
  assertStringIncludes(parsed.extensions[0].pulledAt, "2026-01-01");
});

Deno.test("renderExtensionList json mode verbose still outputs all files", () => {
  const output = captureConsoleLog(() => {
    renderExtensionList(
      {
        extensions: [
          {
            name: "@test/ext",
            version: "2026.01.01.1",
            pulledAt: "2026-01-01T00:00:00.000Z",
            files: ["a.yaml", "b.ts"],
          },
        ],
      },
      "json",
      true,
    );
  });
  const parsed = JSON.parse(output);
  assertEquals(parsed.extensions[0].files, ["a.yaml", "b.ts"]);
});
