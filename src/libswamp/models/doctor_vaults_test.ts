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
import { z } from "zod";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  doctorVaults,
  type DoctorVaultsDeps,
  type DoctorVaultsEvent,
} from "./doctor_vaults.ts";

type DefStub = {
  id: string;
  name: string;
  globalArguments: Record<string, unknown>;
};

function makeDeps(
  definitions: { definition: DefStub; type: string }[],
  modelDefForType: (type: string) => object | undefined,
  hasVault: boolean,
): DoctorVaultsDeps {
  return {
    findAllDefinitions: () =>
      Promise.resolve(
        definitions.map(({ definition, type }) => ({
          definition,
          type: { normalized: type },
        })) as Awaited<ReturnType<DoctorVaultsDeps["findAllDefinitions"]>>,
      ),
    getModelDef:
      ((type: { normalized: string }) =>
        modelDefForType(type.normalized)) as DoctorVaultsDeps["getModelDef"],
    hasVault: () => Promise.resolve(hasVault),
  };
}

Deno.test("doctorVaults: no findings when vault is configured", async () => {
  const deps = makeDeps(
    [{
      definition: { id: "d1", name: "my-model", globalArguments: {} },
      type: "test/sensitive",
    }],
    () => ({
      resources: {
        creds: {
          schema: z.object({
            apiKey: z.string().meta({ sensitive: true }),
          }),
          lifetime: "infinite",
          garbageCollection: 5,
        },
      },
    }),
    true,
  );

  const events = await collect<DoctorVaultsEvent>(
    doctorVaults(createLibSwampContext(), deps),
  );
  const completed = events.find((e) => e.kind === "completed");
  assertEquals(completed?.kind, "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.data.findings.length, 0);
    assertEquals(completed.data.hasVault, true);
    assertEquals(completed.data.scanned, 1);
  }
});

Deno.test("doctorVaults: finding when sensitive output and no vault", async () => {
  const deps = makeDeps(
    [{
      definition: { id: "d1", name: "my-model", globalArguments: {} },
      type: "test/sensitive",
    }],
    () => ({
      resources: {
        creds: {
          schema: z.object({
            apiKey: z.string().meta({ sensitive: true }),
          }),
          lifetime: "infinite",
          garbageCollection: 5,
        },
      },
    }),
    false,
  );

  const events = await collect<DoctorVaultsEvent>(
    doctorVaults(createLibSwampContext(), deps),
  );
  const completed = events.find((e) => e.kind === "completed");
  assertEquals(completed?.kind, "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.data.findings.length, 1);
    assertEquals(completed.data.findings[0].definitionName, "my-model");
    assertEquals(completed.data.hasVault, false);
  }
});

Deno.test("doctorVaults: no findings for non-sensitive models without vault", async () => {
  const deps = makeDeps(
    [{
      definition: { id: "d1", name: "plain-model", globalArguments: {} },
      type: "test/plain",
    }],
    () => ({
      resources: {
        output: {
          schema: z.object({ name: z.string() }),
          lifetime: "infinite",
          garbageCollection: 5,
        },
      },
    }),
    false,
  );

  const events = await collect<DoctorVaultsEvent>(
    doctorVaults(createLibSwampContext(), deps),
  );
  const completed = events.find((e) => e.kind === "completed");
  assertEquals(completed?.kind, "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.data.findings.length, 0);
  }
});

Deno.test("doctorVaults: unresolved when model def not found", async () => {
  const deps = makeDeps(
    [{
      definition: { id: "d1", name: "unknown-model", globalArguments: {} },
      type: "test/unknown",
    }],
    () => undefined,
    false,
  );

  const events = await collect<DoctorVaultsEvent>(
    doctorVaults(createLibSwampContext(), deps),
  );
  const completed = events.find((e) => e.kind === "completed");
  assertEquals(completed?.kind, "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.data.findings.length, 0);
    assertEquals(completed.data.unresolved.length, 1);
    assertEquals(completed.data.unresolved[0].definitionName, "unknown-model");
  }
});

Deno.test("doctorVaults: sensitiveOutput flag triggers finding without vault", async () => {
  const deps = makeDeps(
    [{
      definition: { id: "d1", name: "all-sensitive", globalArguments: {} },
      type: "test/sensitive-output",
    }],
    () => ({
      resources: {
        secret: {
          schema: z.object({ data: z.string() }),
          lifetime: "infinite",
          garbageCollection: 5,
          sensitiveOutput: true,
        },
      },
    }),
    false,
  );

  const events = await collect<DoctorVaultsEvent>(
    doctorVaults(createLibSwampContext(), deps),
  );
  const completed = events.find((e) => e.kind === "completed");
  assertEquals(completed?.kind, "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.data.findings.length, 1);
    assertEquals(completed.data.findings[0].definitionName, "all-sensitive");
  }
});
