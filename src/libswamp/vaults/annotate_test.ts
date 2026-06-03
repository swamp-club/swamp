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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import { VaultAnnotation } from "../../domain/vaults/vault_annotation.ts";
import {
  vaultAnnotate,
  type VaultAnnotateDeps,
  type VaultAnnotateEvent,
} from "./annotate.ts";

function makeDeps(
  overrides: Partial<VaultAnnotateDeps> = {},
): VaultAnnotateDeps {
  return {
    findVault: () =>
      Promise.resolve({ id: "v1", name: "my-vault", type: "env" }),
    listVaultNames: () => Promise.resolve(["my-vault"]),
    secretExists: () => Promise.resolve(true),
    supportsAnnotations: () => Promise.resolve(true),
    getAnnotation: () => Promise.resolve(null),
    putAnnotation: () => Promise.resolve(),
    deleteAnnotation: () => Promise.resolve(),
    publishSecretAnnotated: () => Promise.resolve(),
    ...overrides,
  };
}

Deno.test("vaultAnnotate: yields not_found when no vaults configured", async () => {
  const deps = makeDeps({
    findVault: () => Promise.resolve(null),
    listVaultNames: () => Promise.resolve([]),
  });

  const events = await collect<VaultAnnotateEvent>(
    vaultAnnotate(createLibSwampContext(), deps, {
      vaultName: "missing",
      key: "SECRET",
      url: "https://example.com",
      clear: false,
    }),
  );

  const last = events[events.length - 1] as Extract<
    VaultAnnotateEvent,
    { kind: "error" }
  >;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "not_found");
  assertStringIncludes(last.error.message, "No vaults are configured");
});

Deno.test("vaultAnnotate: yields not_found with available vault names", async () => {
  const deps = makeDeps({
    findVault: () => Promise.resolve(null),
    listVaultNames: () => Promise.resolve(["other-vault", "prod-vault"]),
  });

  const events = await collect<VaultAnnotateEvent>(
    vaultAnnotate(createLibSwampContext(), deps, {
      vaultName: "missing",
      key: "SECRET",
      url: "https://example.com",
      clear: false,
    }),
  );

  const last = events[events.length - 1] as Extract<
    VaultAnnotateEvent,
    { kind: "error" }
  >;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "not_found");
  assertStringIncludes(last.error.message, "other-vault, prod-vault");
});

Deno.test("vaultAnnotate: yields validation_failed when secret does not exist", async () => {
  const deps = makeDeps({
    secretExists: () => Promise.resolve(false),
  });

  const events = await collect<VaultAnnotateEvent>(
    vaultAnnotate(createLibSwampContext(), deps, {
      vaultName: "my-vault",
      key: "MISSING_KEY",
      url: "https://example.com",
      clear: false,
    }),
  );

  const last = events[events.length - 1] as Extract<
    VaultAnnotateEvent,
    { kind: "error" }
  >;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "validation_failed");
  assertStringIncludes(last.error.message, "MISSING_KEY");
  assertStringIncludes(last.error.message, "does not exist");
});

Deno.test("vaultAnnotate: yields validation_failed when annotations not supported", async () => {
  const deps = makeDeps({
    supportsAnnotations: () => Promise.resolve(false),
  });

  const events = await collect<VaultAnnotateEvent>(
    vaultAnnotate(createLibSwampContext(), deps, {
      vaultName: "my-vault",
      key: "SECRET",
      url: "https://example.com",
      clear: false,
    }),
  );

  const last = events[events.length - 1] as Extract<
    VaultAnnotateEvent,
    { kind: "error" }
  >;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "validation_failed");
  assertStringIncludes(last.error.message, "does not support annotations");
});

Deno.test("vaultAnnotate: yields validation_failed when no fields specified", async () => {
  const deps = makeDeps();

  const events = await collect<VaultAnnotateEvent>(
    vaultAnnotate(createLibSwampContext(), deps, {
      vaultName: "my-vault",
      key: "SECRET",
      clear: false,
    }),
  );

  const last = events[events.length - 1] as Extract<
    VaultAnnotateEvent,
    { kind: "error" }
  >;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "validation_failed");
  assertStringIncludes(last.error.message, "No annotation fields specified");
});

Deno.test("vaultAnnotate: removeLabels alone is a valid operation", async () => {
  const existing = VaultAnnotation.create({
    labels: { env: "prod", team: "infra" },
  });

  const deps = makeDeps({
    getAnnotation: () => Promise.resolve(existing),
    putAnnotation: () => Promise.resolve(),
  });

  const events = await collect<VaultAnnotateEvent>(
    vaultAnnotate(createLibSwampContext(), deps, {
      vaultName: "my-vault",
      key: "SECRET",
      removeLabels: ["team"],
      clear: false,
    }),
  );

  const completed = events[events.length - 1] as Extract<
    VaultAnnotateEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.fieldsUpdated, ["labels"]);
});

Deno.test("vaultAnnotate: creates new annotation successfully", async () => {
  let savedVault = "";
  let savedKey = "";
  let savedAnnotation: VaultAnnotation | null = null;
  let publishedFields: string[] = [];

  const deps = makeDeps({
    putAnnotation: (_vault, key, annotation) => {
      savedVault = _vault;
      savedKey = key;
      savedAnnotation = annotation;
      return Promise.resolve();
    },
    publishSecretAnnotated: (_id, _type, _name, _key, fields) => {
      publishedFields = fields;
      return Promise.resolve();
    },
  });

  const events = await collect<VaultAnnotateEvent>(
    vaultAnnotate(createLibSwampContext(), deps, {
      vaultName: "my-vault",
      key: "API_KEY",
      url: "https://console.aws.amazon.com",
      notes: "Production API key",
      labels: { env: "prod" },
      clear: false,
    }),
  );

  assertEquals(events[0].kind, "annotating");
  const completed = events[events.length - 1] as Extract<
    VaultAnnotateEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.vaultName, "my-vault");
  assertEquals(completed.data.secretKey, "API_KEY");
  assertEquals(completed.data.vaultType, "env");
  assertEquals(completed.data.cleared, false);
  assertEquals(completed.data.fieldsUpdated, ["url", "notes", "labels"]);

  assertEquals(savedVault, "my-vault");
  assertEquals(savedKey, "API_KEY");
  assertEquals(savedAnnotation!.url, "https://console.aws.amazon.com");
  assertEquals(savedAnnotation!.notes, "Production API key");
  assertEquals(savedAnnotation!.labels, { env: "prod" });
  assertEquals(publishedFields, ["url", "notes", "labels"]);
});

Deno.test("vaultAnnotate: merges with existing annotation", async () => {
  let savedAnnotation: VaultAnnotation | null = null;

  const existing = VaultAnnotation.create({
    url: "https://old.example.com",
    notes: "Old notes",
    labels: { env: "staging" },
  });

  const deps = makeDeps({
    getAnnotation: () => Promise.resolve(existing),
    putAnnotation: (_vault, _key, annotation) => {
      savedAnnotation = annotation;
      return Promise.resolve();
    },
  });

  const events = await collect<VaultAnnotateEvent>(
    vaultAnnotate(createLibSwampContext(), deps, {
      vaultName: "my-vault",
      key: "API_KEY",
      url: "https://new.example.com",
      labels: { region: "us-east-1" },
      clear: false,
    }),
  );

  const completed = events[events.length - 1] as Extract<
    VaultAnnotateEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.fieldsUpdated, ["url", "labels"]);
  assertEquals(completed.data.cleared, false);

  // URL should be updated
  assertEquals(savedAnnotation!.url, "https://new.example.com");
  // Notes should be preserved from existing
  assertEquals(savedAnnotation!.notes, "Old notes");
  // Labels should be merged
  assertEquals(savedAnnotation!.labels.env, "staging");
  assertEquals(savedAnnotation!.labels.region, "us-east-1");
});

Deno.test("vaultAnnotate: clears annotation successfully", async () => {
  let deletedVault = "";
  let deletedKey = "";
  let publishedFields: string[] | null = null;

  const deps = makeDeps({
    deleteAnnotation: (vault, key) => {
      deletedVault = vault;
      deletedKey = key;
      return Promise.resolve();
    },
    publishSecretAnnotated: (_id, _type, _name, _key, fields) => {
      publishedFields = fields;
      return Promise.resolve();
    },
  });

  const events = await collect<VaultAnnotateEvent>(
    vaultAnnotate(createLibSwampContext(), deps, {
      vaultName: "my-vault",
      key: "API_KEY",
      clear: true,
    }),
  );

  assertEquals(events[0].kind, "annotating");
  const completed = events[events.length - 1] as Extract<
    VaultAnnotateEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.vaultName, "my-vault");
  assertEquals(completed.data.secretKey, "API_KEY");
  assertEquals(completed.data.cleared, true);
  assertEquals(completed.data.fieldsUpdated, []);

  assertEquals(deletedVault, "my-vault");
  assertEquals(deletedKey, "API_KEY");
  assertEquals(publishedFields, []);
  assertEquals(completed.data.annotation, null);
});

Deno.test("vaultAnnotate: completed event includes annotation state", async () => {
  const deps = makeDeps({
    putAnnotation: () => Promise.resolve(),
  });

  const events = await collect<VaultAnnotateEvent>(
    vaultAnnotate(createLibSwampContext(), deps, {
      vaultName: "my-vault",
      key: "API_KEY",
      url: "https://example.com",
      notes: "A note",
      clear: false,
    }),
  );

  const completed = events[events.length - 1] as Extract<
    VaultAnnotateEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.annotation!.url, "https://example.com");
  assertEquals(completed.data.annotation!.notes, "A note");
  assertEquals(typeof completed.data.annotation!.updatedAt, "string");
});

Deno.test("vaultAnnotate: removeLabels removes specified labels", async () => {
  let savedAnnotation: VaultAnnotation | null = null;

  const existing = VaultAnnotation.create({
    url: "https://example.com",
    labels: { env: "prod", team: "infra", region: "us" },
  });

  const deps = makeDeps({
    getAnnotation: () => Promise.resolve(existing),
    putAnnotation: (_vault, _key, annotation) => {
      savedAnnotation = annotation;
      return Promise.resolve();
    },
  });

  const events = await collect<VaultAnnotateEvent>(
    vaultAnnotate(createLibSwampContext(), deps, {
      vaultName: "my-vault",
      key: "API_KEY",
      removeLabels: ["team", "region"],
      clear: false,
    }),
  );

  const completed = events[events.length - 1] as Extract<
    VaultAnnotateEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.fieldsUpdated, ["labels"]);
  assertEquals(savedAnnotation!.labels, { env: "prod" });
  assertEquals(savedAnnotation!.url, "https://example.com");
});

Deno.test("vaultAnnotate: removeLabels applied after label additions", async () => {
  let savedAnnotation: VaultAnnotation | null = null;

  const existing = VaultAnnotation.create({
    labels: { env: "prod", team: "infra" },
  });

  const deps = makeDeps({
    getAnnotation: () => Promise.resolve(existing),
    putAnnotation: (_vault, _key, annotation) => {
      savedAnnotation = annotation;
      return Promise.resolve();
    },
  });

  const events = await collect<VaultAnnotateEvent>(
    vaultAnnotate(createLibSwampContext(), deps, {
      vaultName: "my-vault",
      key: "API_KEY",
      labels: { region: "us" },
      removeLabels: ["team"],
      clear: false,
    }),
  );

  const completed = events[events.length - 1] as Extract<
    VaultAnnotateEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(savedAnnotation!.labels, { env: "prod", region: "us" });
});
