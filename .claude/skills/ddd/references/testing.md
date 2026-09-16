# Testing Templates

Copy-pasteable templates for the test types required by each building block. See
the canonical examples for the full pattern.

## Property Test

Use `fast-check` to assert invariants across random inputs. Place next to the
source as `foo_property_test.ts`.

Canonical example: `src/domain/data/composite_name_property_test.ts`

```typescript
import { assertEquals } from "@std/assert";
import fc from "fast-check";
import { MyValueObject } from "./my_value_object.ts";

// Define arbitraries that produce valid domain inputs.
const arbInput = fc.record({
  name: fc.string({ minLength: 1, maxLength: 50 }),
  value: fc.integer({ min: 0 }),
});

Deno.test("MyValueObject.create: round-trips through serialization", () => {
  fc.assert(
    fc.property(arbInput, ({ name, value }) => {
      const original = MyValueObject.create(name, value);
      const roundTripped = MyValueObject.fromJSON(original.toJSON());
      assertEquals(original.equals(roundTripped), true);
    }),
    { numRuns: 200 },
  );
});

Deno.test("MyValueObject.create: rejects invalid inputs", () => {
  fc.assert(
    fc.property(
      fc.string({ maxLength: 0 }), // empty strings
      (name) => {
        try {
          MyValueObject.create(name, 0);
          return false; // should have thrown
        } catch {
          return true;
        }
      },
    ),
    { numRuns: 200 },
  );
});
```

### Common invariants to test

- **Round-trip**: `deserialize(serialize(x))` equals `x`
- **Equality symmetry**: `a.equals(b)` implies `b.equals(a)`
- **Factory rejection**: `create()` with invalid random inputs always throws
- **Idempotency**: applying an operation twice gives the same result as once
- **Monotonicity**: appending to a collection never shrinks it

## Conformance Suite

For new provider interfaces that extension authors implement. Place in
`packages/testing/`.

Canonical example: `packages/testing/datastore_conformance.ts`

```typescript
import { assertEquals, assertExists } from "@std/assert";
import type { MyProvider } from "./my_provider_types.ts";

export interface MyProviderExport {
  type: string;
  name: string;
  description: string;
  configSchema: { safeParse: (v: unknown) => { success: boolean } };
  createProvider: (config: Record<string, unknown>) => MyProvider;
}

export interface MyProviderConformanceOptions {
  validConfigs: Record<string, unknown>[];
  invalidConfigs?: Record<string, unknown>[];
}

export function assertMyProviderExportConformance(
  mod: MyProviderExport,
  opts: MyProviderConformanceOptions,
): void {
  assertExists(mod.type);
  assertExists(mod.name);
  assertExists(mod.description);

  for (const config of opts.validConfigs) {
    assertEquals(mod.configSchema.safeParse(config).success, true);
  }

  for (const config of opts.invalidConfigs ?? []) {
    assertEquals(mod.configSchema.safeParse(config).success, false);
  }

  const provider = mod.createProvider(opts.validConfigs[0]);
  assertExists(provider);
}
```

## Architectural Fitness Rule

For enforcing module boundaries. Place in `integration/` as `*_rules_test.ts`.

Canonical example: `integration/ddd_layer_rules_test.ts`

```typescript
import { assertEquals } from "@std/assert";
import {
  assertPinnedSet,
  collectImportEdges,
  importsLayer,
  SRC_DIR,
} from "./arch_fitness_helpers.ts";

// Pinned ratchet: the exact set of violations allowed today.
// This list can only shrink — fixing a violation means removing it.
// Adding a new entry means you introduced a new boundary violation.
const PINNED: readonly string[] = [
  // "src/domain/foo.ts -> src/infrastructure/bar.ts",
];

Deno.test("myModule: does not import from forbiddenLayer", async () => {
  const edges = await collectImportEdges(
    SRC_DIR,
    (filePath, importPath) =>
      isUnder(repoRelative(filePath), "src/myModule") &&
      importsLayer(filePath, importPath, "forbiddenLayer"),
  );

  assertPinnedSet(
    edges,
    PINNED,
    "myModule -> forbiddenLayer",
    "Do not add new edges. Fix the import or move the code.",
  );
});
```
