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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  InvalidExpressionError,
  SECRET_DESTINATION_REFUSED,
  SecretRefusedError,
} from "../expressions/errors.ts";
import { SecretBagRegistry } from "../vaults/secret_bag_registry.ts";
import { VaultSecretBag } from "../vaults/vault_secret_bag.ts";
import { TriggerInputResolver } from "./trigger_input_resolver.ts";
import type { ExpressionContext } from "../expressions/model_resolver.ts";
import { CelEvaluator } from "../../infrastructure/cel/cel_evaluator.ts";

function contextWith(webhook: ExpressionContext["webhook"]): ExpressionContext {
  return { model: {}, env: {}, webhook };
}

const linearContext = contextWith({
  body: { data: { issue: { identifier: "PLT-1057" } } },
  headers: { "x-linear-event": "Issue" },
  route: "/hooks/linear",
});

Deno.test("TriggerInputResolver: passes static literals through unchanged", async () => {
  const resolver = new TriggerInputResolver(new CelEvaluator());
  const result = await resolver.resolve(
    { projectId: "a6b254a2", count: 3, enabled: true },
    contextWith(undefined),
  );
  assertEquals(result, { projectId: "a6b254a2", count: 3, enabled: true });
});

Deno.test("TriggerInputResolver: resolves a whole-value webhook expression", async () => {
  const resolver = new TriggerInputResolver(new CelEvaluator());
  const result = await resolver.resolve(
    { identifier: "${{ webhook.body.data.issue.identifier }}" },
    linearContext,
  );
  assertEquals(result, { identifier: "PLT-1057" });
});

Deno.test("TriggerInputResolver: reads a header via webhook.headers", async () => {
  const resolver = new TriggerInputResolver(new CelEvaluator());
  const result = await resolver.resolve(
    { eventType: '${{ webhook.headers["x-linear-event"] }}' },
    linearContext,
  );
  assertEquals(result, { eventType: "Issue" });
});

Deno.test("TriggerInputResolver: preserves the native type of a whole-value expression", async () => {
  const resolver = new TriggerInputResolver(new CelEvaluator());
  const ctx = contextWith({
    body: { count: 42, nested: { ok: true } },
    headers: {},
    route: "/hooks/x",
  });
  const result = await resolver.resolve(
    {
      count: "${{ webhook.body.count }}",
      nested: "${{ webhook.body.nested }}",
    },
    ctx,
  );
  assertEquals(result, { count: 42, nested: { ok: true } });
});

Deno.test("TriggerInputResolver: interpolates an expression embedded in a string", async () => {
  const resolver = new TriggerInputResolver(new CelEvaluator());
  const result = await resolver.resolve(
    { ref: "issue-${{ webhook.body.data.issue.identifier }}" },
    linearContext,
  );
  assertEquals(result, { ref: "issue-PLT-1057" });
});

Deno.test("TriggerInputResolver: resolves nested object and array values", async () => {
  const resolver = new TriggerInputResolver(new CelEvaluator());
  const result = await resolver.resolve(
    {
      meta: { id: "${{ webhook.body.data.issue.identifier }}", static: "x" },
      tags: ["${{ webhook.body.data.issue.identifier }}", "literal"],
    },
    linearContext,
  );
  assertEquals(result, {
    meta: { id: "PLT-1057", static: "x" },
    tags: ["PLT-1057", "literal"],
  });
});

Deno.test("TriggerInputResolver: supports has()/ternary fallback for a missing field", async () => {
  const resolver = new TriggerInputResolver(new CelEvaluator());
  const ctx = contextWith({
    body: { data: { identifier: "FALLBACK-1" } },
    headers: {},
    route: "/hooks/x",
  });
  const result = await resolver.resolve(
    {
      identifier:
        "${{ has(webhook.body.data.issue) ? webhook.body.data.issue.identifier : webhook.body.data.identifier }}",
    },
    ctx,
  );
  assertEquals(result, { identifier: "FALLBACK-1" });
});

Deno.test("TriggerInputResolver: resolves a multi-line whole-value expression", async () => {
  const resolver = new TriggerInputResolver(new CelEvaluator());
  const ctx = contextWith({
    body: {},
    headers: {
      "x-github-delivery": "gh-abc",
      "linear-delivery": "lin-xyz",
    },
    route: "/hooks/github",
  });
  const result = await resolver.resolve(
    {
      deliveryId:
        '${{ webhook.route == "/hooks/github"\n? webhook.headers["x-github-delivery"]\n: webhook.headers["linear-delivery"] }}',
    },
    ctx,
  );
  assertEquals(result, { deliveryId: "gh-abc" });
});

Deno.test("TriggerInputResolver: resolves a whole-value expression with trailing newline", async () => {
  const resolver = new TriggerInputResolver(new CelEvaluator());
  const ctx = contextWith({
    body: { id: 42 },
    headers: {},
    route: "/hooks/x",
  });
  const result = await resolver.resolve(
    { count: "${{ webhook.body.id }}\n" },
    ctx,
  );
  assertEquals(result, { count: 42 });
});

Deno.test("TriggerInputResolver: resolves a multi-line embedded expression", async () => {
  const resolver = new TriggerInputResolver(new CelEvaluator());
  const ctx = contextWith({
    body: {},
    headers: { "x-github-delivery": "gh-abc" },
    route: "/hooks/github",
  });
  const result = await resolver.resolve(
    {
      ref:
        'delivery-${{ webhook.route == "/hooks/github"\n? webhook.headers["x-github-delivery"]\n: "unknown" }}-end',
    },
    ctx,
  );
  assertEquals(result, { ref: "delivery-gh-abc-end" });
});

Deno.test("TriggerInputResolver: propagates a hard reference error", async () => {
  const resolver = new TriggerInputResolver(new CelEvaluator());
  await assertRejects(() =>
    resolver.resolve(
      { broken: "${{ webhook.body.does.not.exist.deeply }}" },
      contextWith({ body: {}, headers: {}, route: "/hooks/x" }),
    )
  );
});

Deno.test("TriggerInputResolver: with a typed evaluator, a vault.get is refused before any work and a Secret result is refused as a destination, while plain inputs resolve as before (typed-secrets 4.1)", async () => {
  const typed = new CelEvaluator({ typedSecrets: true });
  const resolver = new TriggerInputResolver(typed);
  assertEquals(
    await resolver.resolve(
      { identifier: "${{ webhook.body.data.issue.identifier }}", n: 1 },
      linearContext,
    ),
    { identifier: "PLT-1057", n: 1 },
  );
  const vaultError = await assertRejects(
    () =>
      resolver.resolve(
        { token: "${{ vault.get('prod', 'A') }}" },
        linearContext,
      ),
    InvalidExpressionError,
  );
  assertStringIncludes(
    vaultError.message,
    "vault.get requires the run's secret bag and vault check scope",
  );
  // A sentinel another run issued is text here, since no bag is bound; a
  // Secret can only come from a data accessor, which the webhook context
  // does not bind, so the destination refusal is proven on the evaluator's
  // own scope: a context that does bind a secret-valued accessor.
  const registry = new SecretBagRegistry({ typedSecrets: true });
  const sentinel = new VaultSecretBag(registry).addSecret(
    { vaultName: "prod", key: "A" },
    "in",
  );
  assertEquals(
    await resolver.resolve(
      { s: "${{ webhook.body.s }}" },
      contextWith({
        body: { s: sentinel },
        headers: {},
        route: "/h",
      }),
    ),
    { s: sentinel },
  );
  const refused = await assertRejects(
    () =>
      resolver.resolve(
        { token: "${{ data.latest('db', 'main').attributes.password }}" },
        {
          ...contextWith(undefined),
          data: {
            namespace: "",
            latest: () =>
              Promise.resolve({
                id: "r",
                name: "main",
                version: 1,
                namespace: "",
                modelName: "db",
                attributes: { password: "${{ vault.get('prod', 'A') }}" },
                tags: {
                  type: "resource",
                  "_swamp.sensitiveFields": JSON.stringify(["password"]),
                },
              }),
          },
        } as unknown as ExpressionContext,
      ),
    SecretRefusedError,
  );
  assertEquals(refused.code, SECRET_DESTINATION_REFUSED);
});
