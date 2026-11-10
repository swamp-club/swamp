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
import { join } from "@std/path";
import {
  applyHeader,
  collectFiles,
  HEADER,
  headerStatus,
} from "./add_license_headers.ts";

Deno.test("collectFiles: includes source files from a checkout beneath .claude", async () => {
  const parent = await Deno.makeTempDir();
  const root = join(parent, ".claude", "worktrees", "checkout");
  const sourceFile = join(root, "src", "needs_header.ts");
  const skippedFile = join(root, "src", ".claude", "ignored.ts");

  try {
    await Deno.mkdir(join(root, "src", ".claude"), { recursive: true });
    await Deno.writeTextFile(sourceFile, "export const needsHeader = true;\n");
    await Deno.writeTextFile(skippedFile, "export const ignored = true;\n");

    assertEquals(await collectFiles(root), [sourceFile]);
  } finally {
    await Deno.remove(parent, { recursive: true }).catch(() => {});
  }
});

const BODY = 'import { join } from "@std/path";\n\nexport const x = join("a", "b");\n';

const HEADER_LINES = HEADER.slice(0, -1).split("\n");

const TRUNCATED = HEADER_LINES.slice(0, 16).join("\n") + "\n\n" + BODY;

const ESCAPED = HEADER.replaceAll("and/or", "and\\/or").replaceAll(
  "https://www.gnu.org/licenses/",
  "https:\\/\\/www.gnu.org\\/licenses\\/",
) + "\n" + BODY;

Deno.test("headerStatus: a full header is ok", () => {
  assertEquals(headerStatus(HEADER + "\n" + BODY), "ok");
});

Deno.test("headerStatus: a full header below a shebang is ok", () => {
  assertEquals(
    headerStatus("#!/usr/bin/env -S deno run\n\n" + HEADER + "\n" + BODY),
    "ok",
  );
});

Deno.test("headerStatus: a file without a header is missing", () => {
  assertEquals(headerStatus(BODY), "missing");
  assertEquals(headerStatus("// a comment\n" + BODY), "missing");
});

Deno.test("headerStatus: a header missing its last sentence is malformed", () => {
  assertEquals(headerStatus(TRUNCATED), "malformed");
});

Deno.test("headerStatus: a header with escaped slashes is malformed", () => {
  assertEquals(headerStatus(ESCAPED), "malformed");
});

Deno.test("headerStatus: a marker line with trailing whitespace is malformed, not missing", () => {
  assertEquals(
    headerStatus(HEADER.replace("Framework\n", "Framework  \n") + "\n" + BODY),
    "malformed",
  );
});

Deno.test("applyHeader: completes a truncated header", () => {
  assertEquals(applyHeader(TRUNCATED), {
    kind: "repaired",
    content: HEADER + "\n" + BODY,
  });
});

Deno.test("applyHeader: unescapes a header with escaped slashes", () => {
  assertEquals(applyHeader(ESCAPED), {
    kind: "repaired",
    content: HEADER + "\n" + BODY,
  });
});

Deno.test("applyHeader: a truncated header directly above code gains one blank line", () => {
  const content = HEADER_LINES.slice(0, 15).join("\n") + "\n" + BODY;
  assertEquals(applyHeader(content), {
    kind: "repaired",
    content: HEADER + "\n" + BODY,
  });
});

Deno.test("applyHeader: repairs a truncated header below a shebang and keeps the shebang", () => {
  const shebang = "#!/usr/bin/env -S deno run\n\n";
  assertEquals(applyHeader(shebang + TRUNCATED), {
    kind: "repaired",
    content: shebang + HEADER + "\n" + BODY,
  });
});

Deno.test("applyHeader: repairs a marker line with trailing whitespace to a single header", () => {
  const content = HEADER.replace("Framework\n", "Framework  \n") + "\n" + BODY;
  assertEquals(applyHeader(content), {
    kind: "repaired",
    content: HEADER + "\n" + BODY,
  });
});

Deno.test("applyHeader: prepends a missing header", () => {
  assertEquals(applyHeader(BODY), {
    kind: "added",
    content: HEADER + "\n" + BODY,
  });
});

Deno.test("applyHeader: prepends a missing header below a shebang", () => {
  const shebang = "#!/usr/bin/env -S deno run\n";
  const result = applyHeader(shebang + BODY);
  assertEquals(result, {
    kind: "added",
    content: shebang + "\n" + HEADER + "\n" + BODY,
  });
  assertEquals(headerStatus(result.content), "ok");
});

Deno.test("applyHeader: leaves a full header byte-for-byte unchanged", () => {
  const content = HEADER + "\n" + BODY;
  assertEquals(applyHeader(content), { kind: "unchanged", content });
});

Deno.test("applyHeader: refuses a header that differs part-way through", () => {
  const content = HEADER.replace(
    "Elder Swamp Club, Inc.",
    "Someone Else",
  ) + "\n" + BODY;
  assertEquals(applyHeader(content), { kind: "unrepairable", content });
});

Deno.test("applyHeader: refuses a truncated header directly followed by a comment", () => {
  const content = HEADER_LINES.slice(0, 15).join("\n") +
    "\n// a real comment\n" + BODY;
  assertEquals(applyHeader(content), { kind: "unrepairable", content });
});

Deno.test("applyHeader: refuses a header below an unrelated first comment", () => {
  const content = "// an unrelated comment\n" + HEADER + "\n" + BODY;
  assertEquals(applyHeader(content), { kind: "unrepairable", content });
});

Deno.test("collectFiles: includes source files under extensions", async () => {
  const root = await Deno.makeTempDir();
  const extensionFile = join(root, "extensions", "models", "needs_header.ts");

  try {
    await Deno.mkdir(join(root, "extensions", "models"), { recursive: true });
    await Deno.writeTextFile(extensionFile, "export const x = 1;\n");

    assertEquals(await collectFiles(root), [extensionFile]);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});
