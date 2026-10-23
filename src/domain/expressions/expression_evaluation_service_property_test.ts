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

import { assertEquals, assertRejects } from "@std/assert";
import fc from "fast-check";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { SecretDestinationRefusedError } from "../models/secret_destinations.ts";
import { SecretBagRegistry } from "../vaults/secret_bag_registry.ts";
import { VaultSecretBag } from "../vaults/vault_secret_bag.ts";
import { ExpressionEvaluationService } from "./expression_evaluation_service.ts";
import { ProvenanceMap } from "./provenance_map.ts";

Deno.test("resolveRuntimeExpressionsInData: nested issued references always refuse, while plain values and foreign sentinel text round-trip unchanged", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const service = new ExpressionEvaluationService(
      new YamlDefinitionRepository(dir),
      dir,
    );
    await fc.assert(fc.asyncProperty(
      fc.jsonValue(),
      fc.string(),
      fc.array(fc.boolean(), { maxLength: 12 }),
      fc.boolean(),
      async (plain, surrounding, layers, inKey) => {
        const registry = new SecretBagRegistry();
        const bag = new VaultSecretBag(registry);
        const sentinel = bag.addSecret({
          vaultName: "never-read",
          key: "token",
        }, "source");
        const text = `${surrounding}${sentinel}${surrounding}`;
        let value: unknown = inKey ? { [text]: plain } : text;
        for (const array of layers) {
          value = array ? [plain, value] : { plain, nested: value };
        }
        const options = {
          secretBag: bag,
          destination: "placement",
          location: "step.placement",
        };
        const error = await assertRejects(
          () =>
            service.resolveRuntimeExpressionsInData(
              value,
              undefined,
              undefined,
              new Set(),
              ProvenanceMap.data(),
              options,
            ),
          SecretDestinationRefusedError,
        );
        assertEquals(error.code, "secret_destination_refused");
        assertEquals(error.message.includes(sentinel), false);
        // No vault is configured: attempting to load would fail the test with
        // a different error. Even reference-shaped data remains inert.
        const ordinary = {
          plain,
          text: surrounding,
          foreign: "__SWAMP_VSEC_ffffffffffffffffffffffffffffffff_0__",
          literal: "${{ vault.get('never-read', 'token') }}",
        };
        assertEquals(
          await service.resolveRuntimeExpressionsInData(
            ordinary,
            undefined,
            undefined,
            new Set(),
            ProvenanceMap.data(),
            options,
          ),
          ordinary,
        );
      },
    ));
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});
