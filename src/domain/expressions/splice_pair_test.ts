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

import { assertEquals, assertThrows } from "@std/assert";
import { SecretRefusedError } from "./errors.ts";
import { ProvenanceMap } from "./provenance_map.ts";
import { RunSensitiveValues } from "../secrets/mod.ts";
import { VaultSecretBag } from "../vaults/vault_secret_bag.ts";
import { SecretBagRegistry } from "../vaults/secret_bag_registry.ts";
import {
  isDefinitionArgumentPath,
  isDeliveredWithMethod,
  sensitiveSpliceSanitizer,
  SplicePair,
} from "./splice_pair.ts";

const expr = "${{ data.latest('db', 'creds').attributes.password }}";
const recordExpr = "${{ data.latest('db', 'creds').attributes }}";

function setup() {
  const values = new RunSensitiveValues();
  values.addSecret("s3cret-pw", { vaultName: "prod", key: "db-password" });
  return { values, bag: new VaultSecretBag(new SecretBagRegistry()) };
}

Deno.test("isDefinitionArgumentPath: accepts only argument paths", () => {
  assertEquals(isDefinitionArgumentPath("globalArguments.token"), true);
  assertEquals(isDefinitionArgumentPath("methods.run.arguments.run"), true);
  assertEquals(isDefinitionArgumentPath("methods.run.arguments[0]"), true);
  assertEquals(isDefinitionArgumentPath("name"), false);
  assertEquals(isDefinitionArgumentPath("tags.env"), false);
  assertEquals(isDefinitionArgumentPath("methods.run.description"), false);
});

Deno.test("isDeliveredWithMethod: accepts paths outside methods and under the named method only", () => {
  assertEquals(isDeliveredWithMethod("globalArguments.token", "run"), true);
  assertEquals(isDeliveredWithMethod("tags.env", "run"), true);
  assertEquals(isDeliveredWithMethod("methods.run", "run"), true);
  assertEquals(isDeliveredWithMethod("methods.run.arguments.key", "run"), true);
  assertEquals(
    isDeliveredWithMethod("methods.run.arguments.list[0]", "run"),
    true,
  );
  // A name that merely starts with the method's is another method.
  assertEquals(
    isDeliveredWithMethod("methods.runner.arguments.key", "run"),
    false,
  );
  assertEquals(
    isDeliveredWithMethod("methods.other.arguments.key", "run"),
    false,
  );
  // A quoted method name is spelled as expression extraction spells it.
  assertEquals(
    isDeliveredWithMethod('methods["a.b"].arguments.key', "a.b"),
    true,
  );
  assertEquals(
    isDeliveredWithMethod('methods["a.b"].arguments.key', "a"),
    false,
  );
  // No method: the global arguments alone.
  assertEquals(isDeliveredWithMethod("globalArguments.token", ""), true);
  assertEquals(isDeliveredWithMethod("methods.run.arguments.key", ""), false);
});

Deno.test("SplicePair.splice: both copies keep the reference sentinel produced by the evaluator", () => {
  const { bag } = setup();
  const pair = SplicePair.of({ run: `echo "${expr}"` }).splice(
    new Map([[
      expr,
      bag.addDataReference({ vaultName: "prod", key: "db-password" }, "args"),
    ]]),
    sensitiveSpliceSanitizer(bag),
  );
  assertEquals(pair.sanitized, pair.raw);
  assertEquals(pair.sanitized.run.includes("s3cret-pw"), false);
  assertEquals(pair.sanitized, pair.raw);
});

Deno.test("SplicePair.splice: authored text equal to a secret is never rewritten", () => {
  const { bag } = setup();
  const pair = SplicePair.of({ run: `s3cret-pw ${expr}` }).splice(
    new Map([[expr, "other"]]),
    sensitiveSpliceSanitizer(bag),
  );
  assertEquals(pair.sanitized, { run: "s3cret-pw other" });
});

Deno.test("SplicePair.splice: a multi-line secret inside an embedded object stays valid JSON", () => {
  const values = new RunSensitiveValues();
  const pem = '-----BEGIN KEY-----\nabc"def\n-----END KEY-----';
  values.addSecret(pem, { vaultName: "prod", key: "tls" });
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const pair = SplicePair.of({ body: `payload=${recordExpr}` }).splice(
    new Map([[recordExpr, { key: pem }]]),
    sensitiveSpliceSanitizer(bag),
  );
  assertEquals(pair.sanitized.body.includes("BEGIN KEY"), true);
  const restored = bag.resolveDeep(pair.sanitized) as { body: string };
  assertEquals(
    JSON.parse(restored.body.slice("payload=".length)).key,
    pem,
  );
});

Deno.test("SplicePair.splice: whole-field objects are sentinelized deeply", () => {
  const { bag } = setup();
  const pair = SplicePair.of<Record<string, unknown>>({ creds: recordExpr })
    .splice(
      new Map([[recordExpr, {
        user: "app",
        password: bag.addDataReference({
          vaultName: "prod",
          key: "db-password",
        }, "args"),
      }]]),
      sensitiveSpliceSanitizer(bag),
    );
  assertEquals(pair.raw, pair.sanitized);
  const sanitized = pair.sanitized as unknown as {
    creds: { password: string };
  };
  assertEquals(sanitized.creds.password.startsWith("__SWAMP_VSEC_"), true);
});

Deno.test("sensitiveSpliceSanitizer: keeps issued sentinels at every splice path", () => {
  const { bag } = setup();
  const pair = SplicePair.of({
    name: expr,
    globalArguments: { token: expr },
  }).splice(
    new Map([[
      expr,
      bag.addDataReference({ vaultName: "prod", key: "db-password" }, "args"),
    ]]),
    sensitiveSpliceSanitizer(bag),
  );
  assertEquals(pair.sanitized.name, pair.sanitized.globalArguments.token);
  assertEquals(
    (pair.sanitized.globalArguments.token as string).includes("s3cret-pw"),
    false,
  );
});

Deno.test("SplicePair.splice: refuses an issued secret in an interpolated container, with plain and whole-field controls", () => {
  const { bag } = setup();
  const sentinel = bag.addDataReference(
    { vaultName: "prod", key: "tls" },
    "args",
  );
  const foreign = "__SWAMP_VSEC_" + "f".repeat(32) + "_0__";
  for (
    const provenance of [
      ProvenanceMap.authored(),
      ProvenanceMap.authored().graft("other", ProvenanceMap.data()),
    ]
  ) {
    for (const value of [{ key: sentinel }, [sentinel]]) {
      const error = assertThrows(
        () =>
          SplicePair.of(
            { body: `payload=${recordExpr}` },
            provenance,
          ).splice(
            new Map([[recordExpr, value]]),
            sensitiveSpliceSanitizer(bag),
          ),
        SecretRefusedError,
      );
      assertEquals(error.code, "secret_operation_unsupported");
    }
  }
  const plain = SplicePair.of({ body: `payload=${recordExpr}` }).splice(
    new Map([[recordExpr, { key: foreign }]]),
    sensitiveSpliceSanitizer(bag),
  );
  assertEquals(plain.raw, plain.sanitized);
  assertEquals(JSON.parse(plain.sanitized.body.slice(8)), { key: foreign });
  const whole = SplicePair.of<Record<string, unknown>>({ body: recordExpr })
    .splice(
      new Map([[recordExpr, { key: sentinel }]]),
      sensitiveSpliceSanitizer(bag),
    );
  assertEquals(whole.sanitized.body, { key: sentinel });
});
