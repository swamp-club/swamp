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
import { parseEnvFile } from "./verify_env.ts";

Deno.test("parseEnvFile reads plain KEY=VALUE pairs", () => {
  assertEquals(
    parseEnvFile("TESSL_TOKEN=tsk-abc\nANTHROPIC_API_KEY=sk-ant-xyz\n"),
    { TESSL_TOKEN: "tsk-abc", ANTHROPIC_API_KEY: "sk-ant-xyz" },
  );
});

Deno.test("parseEnvFile skips comments and blank lines", () => {
  assertEquals(
    parseEnvFile("# a comment\n\n  \nTESSL_TOKEN=tsk-abc\n# trailing\n"),
    { TESSL_TOKEN: "tsk-abc" },
  );
});

Deno.test("parseEnvFile tolerates export prefixes and quoted values", () => {
  assertEquals(
    parseEnvFile(`export TESSL_TOKEN="tsk-abc"\nOTHER='single'\n`),
    { TESSL_TOKEN: "tsk-abc", OTHER: "single" },
  );
});

Deno.test("parseEnvFile keeps characters that look like syntax inside a value", () => {
  // Tokens contain '=' and '#'. Splitting on the last '=' or stripping from
  // the first '#' would silently truncate a credential, which fails later as
  // an authentication error rather than a parse error.
  assertEquals(
    parseEnvFile("TOKEN=abc=def#ghi\n"),
    { TOKEN: "abc=def#ghi" },
  );
});

Deno.test("parseEnvFile ignores malformed lines rather than throwing", () => {
  assertEquals(parseEnvFile("no-equals-here\n=novalue\n9BAD=x\nOK=1\n"), {
    OK: "1",
  });
});
