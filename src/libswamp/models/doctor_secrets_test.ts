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
  doctorSecrets,
  type DoctorSecretsDeps,
  type DoctorSecretsEvent,
} from "./doctor_secrets.ts";

const SECRET = "SUPERSECRET123";

const sensitiveSchema = z.object({
  apiKey: z.string().meta({ sensitive: true }),
  region: z.string(),
});

type DefStub = {
  id: string;
  name: string;
  globalArguments: Record<string, unknown>;
};

function makeDeps(
  definitions: { definition: DefStub; type: string }[],
  modelDefForType: (type: string) => object | undefined,
): DoctorSecretsDeps {
  return {
    findAllDefinitions: () =>
      Promise.resolve(
        definitions.map(({ definition, type }) => ({
          definition,
          type: { normalized: type },
        })) as Awaited<ReturnType<DoctorSecretsDeps["findAllDefinitions"]>>,
      ),
    getModelDef:
      ((type: { normalized: string }) =>
        modelDefForType(type.normalized)) as DoctorSecretsDeps["getModelDef"],
  };
}

function completedData(events: DoctorSecretsEvent[]) {
  const completed = events.find((e) => e.kind === "completed");
  if (!completed || completed.kind !== "completed") {
    throw new Error("expected a completed event");
  }
  return completed.data;
}

Deno.test("doctorSecrets: yields scanning then completed", async () => {
  const deps = makeDeps([], () => undefined);
  const events = await collect<DoctorSecretsEvent>(
    doctorSecrets(createLibSwampContext(), deps),
  );

  assertEquals(events[0], { kind: "scanning" });
  assertEquals(events.at(-1)?.kind, "completed");
});

Deno.test("doctorSecrets: flags a definition with a cleartext sensitive arg", async () => {
  const deps = makeDeps(
    [{
      definition: {
        id: "def-1",
        name: "my-creds",
        globalArguments: { apiKey: SECRET, region: "us-east-1" },
      },
      type: "acme/api",
    }],
    () => ({ globalArguments: sensitiveSchema }),
  );

  const events = await collect<DoctorSecretsEvent>(
    doctorSecrets(createLibSwampContext(), deps),
  );
  const data = completedData(events);

  assertEquals(data.scanned, 1);
  assertEquals(data.findings.length, 1);
  assertEquals(data.findings[0].definitionName, "my-creds");
  assertEquals(data.findings[0].leakedPaths, ["apiKey"]);
  assertEquals(data.unresolved.length, 0);
});

Deno.test("doctorSecrets: never includes the secret value in findings", async () => {
  const deps = makeDeps(
    [{
      definition: {
        id: "def-1",
        name: "my-creds",
        globalArguments: { apiKey: SECRET, region: "us-east-1" },
      },
      type: "acme/api",
    }],
    () => ({ globalArguments: sensitiveSchema }),
  );

  const events = await collect<DoctorSecretsEvent>(
    doctorSecrets(createLibSwampContext(), deps),
  );

  // The entire completed payload must be free of the cleartext secret.
  assertEquals(JSON.stringify(completedData(events)).includes(SECRET), false);
});

Deno.test("doctorSecrets: ignores a vault.get expression value", async () => {
  const deps = makeDeps(
    [{
      definition: {
        id: "def-1",
        name: "safe-creds",
        globalArguments: {
          apiKey: "${{ vault.get('creds', 'apiKey') }}",
          region: "us-east-1",
        },
      },
      type: "acme/api",
    }],
    () => ({ globalArguments: sensitiveSchema }),
  );

  const data = completedData(
    await collect<DoctorSecretsEvent>(
      doctorSecrets(createLibSwampContext(), deps),
    ),
  );

  assertEquals(data.findings.length, 0);
});

Deno.test("doctorSecrets: reports definitions whose type cannot be resolved", async () => {
  const deps = makeDeps(
    [{
      definition: {
        id: "def-1",
        name: "orphan",
        globalArguments: { apiKey: SECRET },
      },
      type: "missing/extension",
    }],
    () => undefined,
  );

  const data = completedData(
    await collect<DoctorSecretsEvent>(
      doctorSecrets(createLibSwampContext(), deps),
    ),
  );

  assertEquals(data.findings.length, 0);
  assertEquals(data.unresolved.length, 1);
  assertEquals(data.unresolved[0].type, "missing/extension");
});

Deno.test("doctorSecrets: scans multiple definitions and counts them", async () => {
  const deps = makeDeps(
    [
      {
        definition: {
          id: "def-1",
          name: "leaky",
          globalArguments: { apiKey: SECRET },
        },
        type: "acme/api",
      },
      {
        definition: {
          id: "def-2",
          name: "clean",
          globalArguments: { region: "us-east-1" },
        },
        type: "acme/api",
      },
    ],
    () => ({ globalArguments: sensitiveSchema }),
  );

  const data = completedData(
    await collect<DoctorSecretsEvent>(
      doctorSecrets(createLibSwampContext(), deps),
    ),
  );

  assertEquals(data.scanned, 2);
  assertEquals(data.findings.length, 1);
  assertEquals(data.findings[0].definitionName, "leaky");
});
