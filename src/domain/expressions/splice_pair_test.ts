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
import { RunSensitiveValues } from "../secrets/mod.ts";
import { VaultSecretBag } from "../vaults/vault_secret_bag.ts";
import {
  isDefinitionArgumentPath,
  sensitiveSpliceSanitizer,
  SplicePair,
} from "./splice_pair.ts";

const expr = "${{ data.latest('db', 'creds').attributes.password }}";
const recordExpr = "${{ data.latest('db', 'creds').attributes }}";

function setup() {
  const values = new RunSensitiveValues();
  values.addSecret("s3cret-pw", { vaultName: "prod", key: "db-password" });
  return { values, bag: new VaultSecretBag() };
}

Deno.test("isDefinitionArgumentPath: accepts only argument paths", () => {
  assertEquals(isDefinitionArgumentPath("globalArguments.token"), true);
  assertEquals(isDefinitionArgumentPath("methods.run.arguments.run"), true);
  assertEquals(isDefinitionArgumentPath("methods.run.arguments[0]"), true);
  assertEquals(isDefinitionArgumentPath("name"), false);
  assertEquals(isDefinitionArgumentPath("tags.env"), false);
  assertEquals(isDefinitionArgumentPath("methods.run.description"), false);
});

Deno.test("SplicePair.splice: raw copy keeps values, sanitized copy holds sentinels", () => {
  const { values, bag } = setup();
  const pair = SplicePair.of({ run: `echo "${expr}"` }).splice(
    new Map([[expr, "s3cret-pw"]]),
    sensitiveSpliceSanitizer(values, bag),
  );
  assertEquals(pair.raw, { run: 'echo "s3cret-pw"' });
  assertEquals(pair.sanitized.run.includes("s3cret-pw"), false);
  assertEquals(bag.resolveDeep(pair.sanitized), pair.raw);
});

Deno.test("SplicePair.splice: authored text equal to a secret is never rewritten", () => {
  const { values, bag } = setup();
  const pair = SplicePair.of({ run: `s3cret-pw ${expr}` }).splice(
    new Map([[expr, "other"]]),
    sensitiveSpliceSanitizer(values, bag),
  );
  assertEquals(pair.sanitized, { run: "s3cret-pw other" });
});

Deno.test("SplicePair.splice: a multi-line secret inside an embedded object stays valid JSON", () => {
  const values = new RunSensitiveValues();
  const pem = '-----BEGIN KEY-----\nabc"def\n-----END KEY-----';
  values.addSecret(pem, { vaultName: "prod", key: "tls" });
  const bag = new VaultSecretBag();
  const pair = SplicePair.of({ body: `payload=${recordExpr}` }).splice(
    new Map([[recordExpr, { key: pem }]]),
    sensitiveSpliceSanitizer(values, bag),
  );
  assertEquals(pair.sanitized.body.includes("BEGIN KEY"), false);
  const restored = bag.resolveDeep(pair.sanitized) as { body: string };
  assertEquals(
    JSON.parse(restored.body.slice("payload=".length)).key,
    pem,
  );
});

Deno.test("SplicePair.splice: whole-field objects are sentinelized deeply", () => {
  const { values, bag } = setup();
  const pair = SplicePair.of<Record<string, unknown>>({ creds: recordExpr })
    .splice(
      new Map([[recordExpr, { user: "app", password: "s3cret-pw" }]]),
      sensitiveSpliceSanitizer(values, bag),
    );
  assertEquals(pair.raw, { creds: { user: "app", password: "s3cret-pw" } });
  const sanitized = pair.sanitized as unknown as {
    creds: { password: string };
  };
  assertEquals(sanitized.creds.password.startsWith("__SWAMP_VSEC_"), true);
});

Deno.test("sensitiveSpliceSanitizer: leaves paths it does not apply to untouched", () => {
  const { values, bag } = setup();
  const pair = SplicePair.of({
    name: expr,
    globalArguments: { token: expr },
  }).splice(
    new Map([[expr, "s3cret-pw"]]),
    sensitiveSpliceSanitizer(values, bag, isDefinitionArgumentPath),
  );
  assertEquals(pair.sanitized.name, "s3cret-pw");
  assertEquals(
    (pair.sanitized.globalArguments.token as string).includes("s3cret-pw"),
    false,
  );
});
