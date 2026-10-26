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

import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { Optional } from "cel-js";
import {
  SECRET_DESTINATION_REFUSED,
  SecretRefusedError,
} from "../../domain/expressions/errors.ts";
import { SecretBagRegistry } from "../../domain/vaults/secret_bag_registry.ts";
import { VaultSecretBag } from "../../domain/vaults/vault_secret_bag.ts";
import {
  detachForDestination,
  refuseUnboundSecrets,
  SecretBoundary,
} from "./secret_boundary.ts";
import { runInFaultScope, SecretRefusal } from "./secret_fault_context.ts";
import {
  composeSecrets,
  dataReferenceSecret,
  isSecret,
  type Secret,
  secretFromParts,
  secretParts,
  vaultReferenceSecret,
} from "./secret_value.ts";
import { adaptDataRecord } from "./sensitive_record_adapter.ts";
import type { NamespaceReader } from "../../domain/data/namespace.ts";

/** The solo reader, whose own records are those of the solo namespace. */
const SOLO_READER: NamespaceReader = {
  namespace: "",
  readsSoloNamespace: false,
};

const reference = { vaultName: "prod", key: "DB_PASS" };

function issuingBag(): { bag: VaultSecretBag; sentinel: string } {
  const bag = new VaultSecretBag(new SecretBagRegistry());
  return { bag, sentinel: bag.addSecret(reference, "inputs.password") };
}

/** A sentinel-shaped string under a prefix no bag of the run drew. */
const FOREIGN = "__SWAMP_VSEC_00000000000000000000000000000000_0__";

Deno.test("SecretBoundary.bind: an exact sentinel the run issued reads as a Secret holding its reference", () => {
  const { bag, sentinel } = issuingBag();
  const bindings = new SecretBoundary(bag).bind({ password: sentinel });
  const secret = bindings.password;
  assert(isSecret(secret));
  assertEquals(secretParts(secret), [{
    reference,
    dataOrigin: false,
    location: "inputs.password",
    sentinel,
  }]);
});

Deno.test("SecretBoundary.bind: mixed text becomes a composition; other text stays text", () => {
  const { bag, sentinel } = issuingBag();
  const bindings = new SecretBoundary(bag).bind({
    mixed: `user:${sentinel}@host`,
    foreign: `x${FOREIGN}y`,
    plain: "plain",
  });
  const [, part] = secretParts(bindings.mixed)!;
  assertEquals(secretParts(bindings.mixed), ["user:", part, "@host"]);
  assertEquals(bindings.foreign, `x${FOREIGN}y`);
  assertEquals(bindings.plain, "plain");
});

Deno.test("SecretBoundary.bind: a data-origin entry reads as a data-origin Secret", () => {
  const { bag } = issuingBag();
  const dataSentinel = bag.addDataSecret("hunter2", reference);
  const secret = new SecretBoundary(bag).bind({ v: dataSentinel }).v;
  assertEquals(secretParts(secret), [{
    reference,
    dataOrigin: true,
    location: undefined,
    sentinel: dataSentinel,
  }]);
});

Deno.test("SecretBoundary.bind: views keep the shape cel-js reads, null prototypes included, and never mutate the original", () => {
  const { bag, sentinel } = issuingBag();
  const nullPrototype: Record<string, unknown> = Object.create(null);
  nullPrototype.token = sentinel;
  const original = {
    record: { password: sentinel, other: "o" },
    list: [sentinel, "x"],
    nullPrototype,
    frozen: Object.freeze({ token: sentinel }),
    map: new Map([["k", sentinel]]),
    when: new Date(0),
  };
  const bindings = new SecretBoundary(bag).bind(original);
  const record = bindings.record as Record<string, unknown>;
  assert(isSecret(record.password));
  assertEquals(record.other, "o");
  assertEquals(Object.keys(record), ["password", "other"]);
  const list = bindings.list as unknown[];
  assert(Array.isArray(list));
  assertEquals(list.length, 2);
  assert(isSecret(list[0]));
  const viewed = bindings.nullPrototype as Record<string, unknown>;
  assertEquals(Object.getPrototypeOf(viewed), null);
  assert(isSecret(viewed.token));
  assert(isSecret((bindings.frozen as Record<string, unknown>).token));
  // A Map's values bypass getters, and a class instance is not a container.
  assertStrictEquals(bindings.map, original.map);
  assertStrictEquals(bindings.when, original.when);
  // The original is untouched.
  assertEquals(original.record.password, sentinel);
  assertEquals(original.list[0], sentinel);
  // Aliased paths read the same view.
  assertStrictEquals(bindings.record, bindings.record);
});

Deno.test("SecretBoundary.bind: an original getter fires only when its key is read", () => {
  const { bag, sentinel } = issuingBag();
  let loads = 0;
  const model = {
    get resource() {
      loads++;
      return { token: sentinel };
    },
  };
  const bindings = new SecretBoundary(bag).bind({ model: { m: model } });
  const m = (bindings.model as Record<string, Record<string, unknown>>).m;
  assertEquals(loads, 0);
  assertEquals(Object.keys(m), ["resource"]);
  assertEquals(loads, 0);
  assert(isSecret((m.resource as Record<string, unknown>).token));
  assertEquals(loads, 1);
});

Deno.test("SecretBoundary.bind: every read of a Secret counts while recording, and none after", () => {
  const { bag, sentinel } = issuingBag();
  const scope = runInFaultScope((scope) => {
    const bindings = new SecretBoundary(bag).bind({
      record: { password: sentinel, other: "o" },
    });
    const record = bindings.record as Record<string, unknown>;
    void record.other;
    void record.password;
    void record.password;
    scope.recording = false;
    void record.password;
    return scope;
  });
  assertEquals(scope.secretsRead, 2);
});

Deno.test("SecretBoundary.bind: the context is returned as is when the run issued nothing", () => {
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const context = { a: FOREIGN };
  assertStrictEquals(new SecretBoundary(bag).bind(context), context);
});

Deno.test("SecretBoundary.bind: a sentinel with the run's prefix that names no entry fails, and is kept for the evaluator", () => {
  const { bag, sentinel } = issuingBag();
  const unknown = sentinel.replace(/_0__$/, "_7__");
  runInFaultScope((scope) => {
    const bindings = new SecretBoundary(bag).bind({ v: unknown });
    assertThrows(() => bindings.v, Error, "names no secret the run issued");
    assertInstanceOf(scope.boundaryFailure, Error);
  });
});

Deno.test("SecretBoundary.release: a Secret leaves as the sentinel it entered as, and compositions as text", () => {
  const { bag, sentinel } = issuingBag();
  const boundary = new SecretBoundary(bag);
  const entered = boundary.bind({ v: `a${sentinel}b` }).v;
  assertEquals(boundary.release(entered), `a${sentinel}b`);
  assertEquals(
    boundary.release({ list: [entered], nested: { v: entered } }),
    { list: [`a${sentinel}b`], nested: { v: `a${sentinel}b` } },
  );
});

Deno.test("SecretBoundary.release: a vault reference with no sentinel is issued once into the run's registry", () => {
  const { bag } = issuingBag();
  const boundary = new SecretBoundary(bag);
  const secret = vaultReferenceSecret({ vaultName: "v", key: "k" }, "loc");
  const [first, second] = boundary.release([secret, secret]) as string[];
  assertEquals(first, second);
  const entry = bag.registry.issuedEntryOf(first);
  assertEquals(entry?.reference, { vaultName: "v", key: "k" });
  assertEquals(entry && "location" in entry ? entry.location : "", "loc");
});

Deno.test("SecretBoundary.release: converts a Secret inside an Optional, at any depth", () => {
  const { bag, sentinel } = issuingBag();
  const boundary = new SecretBoundary(bag);
  const secret = boundary.bind({ v: sentinel }).v;
  const released = boundary.release({ o: Optional.of(secret) }) as {
    o: Optional;
  };
  assertInstanceOf(released.o, Optional);
  assertEquals(released.o.value(), sentinel);
  assertEquals(boundary.release(Optional.of(secret)), Optional.of(sentinel));
});

Deno.test("SecretBoundary.release: converts a Secret inside a Map, and refuseUnboundSecrets sees one there", () => {
  const { bag, sentinel } = issuingBag();
  const boundary = new SecretBoundary(bag);
  const secret = boundary.bind({ v: sentinel }).v;
  assertEquals(
    boundary.release(new Map([["k", secret]])),
    new Map([["k", sentinel]]),
  );
  assertThrows(
    () => refuseUnboundSecrets(new Map([["k", secret]]), "e"),
    SecretRefusedError,
  );
});

Deno.test("SecretBoundary.release: a data-origin reference with no sentinel fails closed", () => {
  const { bag } = issuingBag();
  const secret = secretFromParts([{ reference, dataOrigin: true }]);
  assertThrows(
    () => new SecretBoundary(bag).release(secret),
    Error,
    "has no sentinel",
  );
});

Deno.test("SecretBoundary.release: a delivery view cannot issue", () => {
  const { bag } = issuingBag();
  const view = bag.withLoaded(new Map());
  assertThrows(
    () =>
      new SecretBoundary(view).release(vaultReferenceSecret(reference, "loc")),
    Error,
    "issues no sentinels",
  );
});

Deno.test("refuseUnboundSecrets: refuses a Secret anywhere in a result, and passes anything else", () => {
  const secret = vaultReferenceSecret(reference, "loc");
  const error = assertThrows(
    () => refuseUnboundSecrets({ a: [Optional.of(secret)] }, "e"),
    SecretRefusedError,
  );
  assertEquals(error.code, SECRET_DESTINATION_REFUSED);
  refuseUnboundSecrets({ a: ["x", 1, null, Optional.none()] }, "e");
});

Deno.test("detachForDestination: copies containers with their prototype, and refuses a Secret at any depth with a fault", () => {
  const { bag, sentinel } = issuingBag();
  const bindings = new SecretBoundary(bag).bind({
    plain: { a: ["x", { b: 1 }] },
    nested: { a: [{ b: Optional.of(sentinel) }] },
  });
  const copied = detachForDestination(bindings.plain, "the inputs");
  assertEquals(copied, { a: ["x", { b: 1 }] });
  assertEquals(Object.getPrototypeOf(copied), Object.prototype);
  assert(
    Object.getOwnPropertyDescriptor(copied, "a")?.get === undefined,
    "a plain value, not a getter",
  );
  runInFaultScope((scope) => {
    // An Optional in a binding is not a container cel-js reads through a
    // view, so the sentinel text in it stays text and passes.
    detachForDestination(bindings.nested, "the inputs");
    const secret = vaultReferenceSecret(reference, "loc");
    assertThrows(
      () => detachForDestination({ deep: [{ v: secret }] }, "the inputs"),
      SecretRefusal,
      "the inputs (secret_destination_refused)",
    );
    assertEquals(scope.faults, [
      { operation: "the inputs", code: SECRET_DESTINATION_REFUSED },
    ]);
  });
});

Deno.test("SecretBoundary.release: a data-origin reference with a location is issued once as a value-less data-origin entry", () => {
  const { bag } = issuingBag();
  const location =
    "data.latest of model 'db' record r1 version 2 (data.latest), field 'password'";
  const secret = dataReferenceSecret(reference, location);
  const boundary = new SecretBoundary(bag);
  const sentinel = boundary.release(secret) as string;
  assertEquals(bag.registry.entryOf(sentinel), {
    sentinel,
    reference,
    encoding: "raw",
    dataOrigin: true,
    location,
  });
  assertEquals(boundary.release(secret), sentinel);
  assertEquals(boundary.release([secret, { k: secret }]), [sentinel, {
    k: sentinel,
  }]);
  assertEquals(bag.rawValues, []);
});

Deno.test("SecretBoundary.bind: a data-origin reference sentinel rebinds as a data-origin Secret with its location, and a composition keeps each part's origin", () => {
  const { bag, sentinel: vault } = issuingBag();
  const location =
    "data.latest of model 'db' record r1 version 2 (data.latest), field 'password'";
  const data = bag.addDataReference({ vaultName: "prod", key: "P" }, location);
  const boundary = new SecretBoundary(bag);
  const bindings = boundary.bind({
    data,
    mixed: `${vault}:${data}`,
    optional: Optional.of(data),
  });
  assertEquals(secretParts(bindings.data), [{
    reference: { vaultName: "prod", key: "P" },
    dataOrigin: true,
    location,
    sentinel: data,
  }]);
  const parts = secretParts(bindings.mixed)!;
  assertEquals(parts.length, 3);
  assertEquals((parts[0] as { dataOrigin: boolean }).dataOrigin, false);
  assertEquals((parts[2] as { dataOrigin: boolean }).dataOrigin, true);
  assertEquals(boundary.release(bindings.mixed), `${vault}:${data}`);
  assertEquals(
    boundary.release(composeSecrets(bindings.data as Secret, "!")),
    `${data}!`,
  );
  assertEquals(
    (boundary.release(bindings.optional) as Optional).value(),
    data,
  );
});

Deno.test("SecretBoundary.release: an adapter view leaves as plain data, with no getter, no Secret and no view", () => {
  const { bag } = issuingBag();
  const attributes = {
    password: "${{ vault.get('prod', 'P') }}",
    nested: { token: "${{ vault.get('prod', 'T') }}", plain: "p" },
    list: [1, "x"],
  };
  const record = {
    id: "r1",
    name: "n",
    version: 1,
    namespace: "",
    modelName: "db",
    attributes,
    content: attributes,
    tags: {
      "_swamp.sensitiveFields": JSON.stringify(["password", "nested.token"]),
    },
  };
  const released = runInFaultScope(() => {
    const view = adaptDataRecord(record, SOLO_READER, "data.latest");
    return new SecretBoundary(bag).release(view) as typeof record;
  });
  structuredClone(released);
  for (
    const [target, key] of [
      [released, "attributes"],
      [released.attributes, "password"],
      [released.attributes.nested, "token"],
    ] as const
  ) {
    assertEquals(
      Object.getOwnPropertyDescriptor(target, key)?.get,
      undefined,
      key,
    );
  }
  assert(typeof released.attributes.password === "string");
  assert(
    bag.registry.issuedEntryOf(released.attributes.password) !== undefined,
  );
  assert(
    bag.registry.issuedEntryOf(released.attributes.nested.token) !== undefined,
  );
  assertEquals(released.attributes.nested.plain, "p");
  assertEquals(released.attributes.list, [1, "x"]);
  assertEquals(released.content, released.attributes);
  assertEquals(released.name, "n");
});

Deno.test("SecretBoundary: a JSON-value data reference leaves CEL as a marked entry and rebinds with its mark (swamp-club#3967)", () => {
  const { bag } = issuingBag();
  const location =
    "data.latest of model 'app' record r1 version 2 (data.latest), field 'spec.services.0.port'";
  const boundary = new SecretBoundary(bag);
  const sentinel = boundary.release(
    dataReferenceSecret(reference, location, true),
  ) as string;
  assertEquals(bag.registry.entryOf(sentinel), {
    sentinel,
    reference,
    encoding: "raw",
    dataOrigin: true,
    location,
    jsonValue: true,
  });
  const bindings = boundary.bind({ port: sentinel });
  assertEquals(secretParts(bindings.port), [{
    reference,
    dataOrigin: true,
    location,
    sentinel,
    jsonValue: true,
  }]);
  assertEquals(boundary.release(bindings.port), sentinel);
  // An unmarked data reference stays unmarked.
  const plain = boundary.release(
    dataReferenceSecret(reference, `${location}x`),
  ) as string;
  assertEquals("jsonValue" in bag.registry.entryOf(plain)!, false);
});
