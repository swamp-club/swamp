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

import { assertStringIncludes } from "@std/assert";
import { stripAnsiCode } from "@std/fmt/colors";
import type {
  ServerTokenCreateData,
  ServerTokenRotateData,
} from "../../libswamp/mod.ts";
import {
  renderServerTokenCreate,
  renderServerTokenRotate,
} from "./access_token_output.ts";

function captureLogs(fn: () => void): string {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    fn();
  } finally {
    console.log = originalLog;
  }
  return stripAnsiCode(logs.join("\n"));
}

const createData: ServerTokenCreateData = {
  name: "swamp-ui",
  principalId: "user:sntxrr",
  expiresAt: "2027-08-07T00:00:00Z",
  vaultRef: { vaultName: "serve-local", secretKey: "server-token-swamp-ui" },
};

const rotateData: ServerTokenRotateData = {
  name: "swamp-ui",
  principalId: "user:sntxrr",
  expiresAt: "2027-08-07T00:00:00Z",
  vaultRef: { vaultName: "serve-local", secretKey: "server-token-swamp-ui" },
};

Deno.test("renderServerTokenCreate: hint uses vault read-secret, not vault get", () => {
  const output = captureLogs(() => renderServerTokenCreate(createData, "log"));
  assertStringIncludes(
    output,
    "swamp vault read-secret serve-local server-token-swamp-ui --yes",
  );
});

Deno.test("renderServerTokenCreate: includes wire-format guidance", () => {
  const output = captureLogs(() => renderServerTokenCreate(createData, "log"));
  assertStringIncludes(output, "swamp-ui.<secret>");
});

Deno.test("renderServerTokenRotate: hint uses vault read-secret, not vault get", () => {
  const output = captureLogs(() => renderServerTokenRotate(rotateData, "log"));
  assertStringIncludes(
    output,
    "swamp vault read-secret serve-local server-token-swamp-ui --yes",
  );
});

Deno.test("renderServerTokenRotate: includes wire-format guidance", () => {
  const output = captureLogs(() => renderServerTokenRotate(rotateData, "log"));
  assertStringIncludes(output, "swamp-ui.<secret>");
});
