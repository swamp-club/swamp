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
import { z } from "zod";
import {
  buildWebhookPayload,
  isSensitiveHeader,
  parseWebhookFlag,
  resolveExtensionWebhookEndpoints,
  resolveSecret,
  type WebhookEndpoint,
  WebhookService,
} from "./webhook.ts";
import type { VaultSecretResolver } from "./webhook.ts";
import { initializeLogging } from "../infrastructure/logging/logger.ts";
import { UserError } from "../domain/errors.ts";
import type { WebhookHandler } from "../domain/webhooks/webhook_handler.ts";
import type { ExtensionWebhookScheme } from "./webhook_verifiers.ts";
import { webhookTypeRegistry } from "../domain/webhooks/webhook_type_registry.ts";
import type { RunTrackerStore } from "../infrastructure/persistence/run_tracker_store.ts";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import type { DatastoreConfig } from "../domain/datastore/datastore_config.ts";

await initializeLogging({});

// ── buildWebhookPayload ────────────────────────────────────────────────

Deno.test("buildWebhookPayload: parses a JSON body into webhook.body", () => {
  const body = new TextEncoder().encode(
    '{"data":{"issue":{"identifier":"PLT-1057"}}}',
  );
  const payload = buildWebhookPayload(body, new Headers(), "/hooks/linear");
  assertEquals(payload.body, {
    data: { issue: { identifier: "PLT-1057" } },
  });
  assertEquals(payload.route, "/hooks/linear");
});

Deno.test("buildWebhookPayload: falls back to the raw string for non-JSON", () => {
  const body = new TextEncoder().encode("not json at all");
  const payload = buildWebhookPayload(body, new Headers(), "/hooks/x");
  assertEquals(payload.body, "not json at all");
});

Deno.test("buildWebhookPayload: lowercases header names", () => {
  const headers = new Headers({ "X-Linear-Event": "Issue" });
  const payload = buildWebhookPayload(
    new TextEncoder().encode("{}"),
    headers,
    "/hooks/x",
  );
  assertEquals(payload.headers["x-linear-event"], "Issue");
});

Deno.test("buildWebhookPayload: drops the signature header", () => {
  const headers = new Headers({
    "X-Hub-Signature-256": "sha256=deadbeef",
    "X-Other": "keep",
  });
  const payload = buildWebhookPayload(
    new TextEncoder().encode("{}"),
    headers,
    "/hooks/x",
  );
  assertEquals("x-hub-signature-256" in payload.headers, false);
  assertEquals(payload.headers["x-other"], "keep");
});

Deno.test("buildWebhookPayload: drops the scheme-specific signature header", () => {
  const headers = new Headers({
    "Stripe-Signature": "t=1,v1=deadbeef",
    "X-Hub-Signature-256": "sha256=keep-me",
  });
  const payload = buildWebhookPayload(
    new TextEncoder().encode("{}"),
    headers,
    "/hooks/stripe",
    "stripe-signature",
  );
  // Only the active scheme's header is excluded; others pass through.
  assertEquals("stripe-signature" in payload.headers, false);
  assertEquals(payload.headers["x-hub-signature-256"], "sha256=keep-me");
});

// ── parseWebhookFlag ───────────────────────────────────────────────────

Deno.test("parseWebhookFlag: parses valid flag", async () => {
  const result = await parseWebhookFlag("/hooks/github:my-workflow:mysecret");
  assertEquals(result, {
    route: "/hooks/github",
    workflowIdOrName: "my-workflow",
    secret: "mysecret",
    verifier: { scheme: "github" },
  });
});

Deno.test("parseWebhookFlag: three-field form defaults to github", async () => {
  const result = await parseWebhookFlag("/hooks/gh:deploy:mysecret");
  assertEquals(result.verifier, { scheme: "github" });
});

Deno.test("parseWebhookFlag: secret can contain colons (legacy 3-field form)", async () => {
  const result = await parseWebhookFlag(
    "/hooks/gh:deploy:secret:with:colons",
  );
  assertEquals(result.route, "/hooks/gh");
  assertEquals(result.workflowIdOrName, "deploy");
  assertEquals(result.secret, "secret:with:colons");
  assertEquals(result.verifier, { scheme: "github" });
});

Deno.test("parseWebhookFlag: parses an explicit linear scheme", async () => {
  const result = await parseWebhookFlag("/hooks/linear:wf:mysecret:linear");
  assertEquals(result.secret, "mysecret");
  assertEquals(result.verifier, { scheme: "linear" });
});

Deno.test("parseWebhookFlag: parses stripe and slack schemes", async () => {
  assertEquals(
    (await parseWebhookFlag("/hooks/s:wf:sec:stripe")).verifier,
    { scheme: "stripe" },
  );
  assertEquals(
    (await parseWebhookFlag("/hooks/s:wf:sec:slack")).verifier,
    { scheme: "slack" },
  );
});

Deno.test("parseWebhookFlag: parses generic scheme with header and prefix", async () => {
  const result = await parseWebhookFlag(
    "/hooks/x:wf:sec:generic:X-Signature:sha256=",
  );
  assertEquals(result.verifier, {
    scheme: "generic",
    header: "X-Signature",
    prefix: "sha256=",
  });
});

Deno.test("parseWebhookFlag: generic prefix defaults to empty", async () => {
  const result = await parseWebhookFlag("/hooks/x:wf:sec:generic:X-Signature");
  assertEquals(result.verifier, {
    scheme: "generic",
    header: "X-Signature",
    prefix: "",
  });
});

Deno.test("parseWebhookFlag: a non-scheme 4th field stays part of a colon-secret", async () => {
  // 'nope' is not a known scheme, so the legacy interpretation wins: the secret
  // is everything after the 2nd colon and the scheme defaults to github.
  const result = await parseWebhookFlag("/hooks/x:wf:sec:nope");
  assertEquals(result.secret, "sec:nope");
  assertEquals(result.verifier, { scheme: "github" });
});

Deno.test("parseWebhookFlag: rejects generic without a header", async () => {
  await assertRejects(
    () => parseWebhookFlag("/hooks/x:wf:sec:generic"),
    Error,
    "'generic' scheme requires a header",
  );
});

Deno.test("parseWebhookFlag: rejects missing first colon", async () => {
  await assertRejects(
    () => parseWebhookFlag("/hooks/github"),
    Error,
    "Invalid --webhook format",
  );
});

Deno.test("parseWebhookFlag: rejects missing second colon", async () => {
  await assertRejects(
    () => parseWebhookFlag("/hooks/github:my-workflow"),
    Error,
    "Invalid --webhook format",
  );
});

Deno.test("parseWebhookFlag: rejects empty route", async () => {
  await assertRejects(
    () => parseWebhookFlag(":my-workflow:secret"),
    Error,
    "must all be non-empty",
  );
});

Deno.test("parseWebhookFlag: rejects empty workflow", async () => {
  await assertRejects(
    () => parseWebhookFlag("/hooks/github::secret"),
    Error,
    "must all be non-empty",
  );
});

Deno.test("parseWebhookFlag: rejects empty secret", async () => {
  await assertRejects(
    () => parseWebhookFlag("/hooks/github:my-workflow:"),
    Error,
    "must all be non-empty",
  );
});

Deno.test("parseWebhookFlag: rejects route without leading slash", async () => {
  await assertRejects(
    () => parseWebhookFlag("hooks/github:my-workflow:secret"),
    Error,
    "must start with '/'",
  );
});

// ── resolveSecret ─────────────────────────────────────────────────────

Deno.test("resolveSecret: returns a literal string unchanged", async () => {
  assertEquals(await resolveSecret("mysecretvalue"), "mysecretvalue");
});

Deno.test("resolveSecret: reads from an environment variable via @env=", async () => {
  Deno.env.set("TEST_WEBHOOK_SECRET_758", "env-secret-value");
  try {
    assertEquals(
      await resolveSecret("@env=TEST_WEBHOOK_SECRET_758"),
      "env-secret-value",
    );
  } finally {
    Deno.env.delete("TEST_WEBHOOK_SECRET_758");
  }
});

Deno.test("resolveSecret: throws for an unset environment variable", async () => {
  Deno.env.delete("NONEXISTENT_WEBHOOK_VAR_758");
  await assertRejects(
    () => resolveSecret("@env=NONEXISTENT_WEBHOOK_VAR_758"),
    Error,
    "not set or is empty",
  );
});

Deno.test("resolveSecret: throws for an empty environment variable", async () => {
  Deno.env.set("EMPTY_WEBHOOK_VAR_758", "");
  try {
    await assertRejects(
      () => resolveSecret("@env=EMPTY_WEBHOOK_VAR_758"),
      Error,
      "not set or is empty",
    );
  } finally {
    Deno.env.delete("EMPTY_WEBHOOK_VAR_758");
  }
});

Deno.test("resolveSecret: reads from a file via @file=", async () => {
  const tmpFile = Deno.makeTempFileSync();
  try {
    Deno.writeTextFileSync(tmpFile, "file-secret-value\n");
    assertEquals(await resolveSecret(`@file=${tmpFile}`), "file-secret-value");
  } finally {
    Deno.removeSync(tmpFile);
  }
});

Deno.test("resolveSecret: trims trailing CRLF from file", async () => {
  const tmpFile = Deno.makeTempFileSync();
  try {
    Deno.writeTextFileSync(tmpFile, "file-secret\r\n");
    assertEquals(await resolveSecret(`@file=${tmpFile}`), "file-secret");
  } finally {
    Deno.removeSync(tmpFile);
  }
});

Deno.test("resolveSecret: throws for a missing file", async () => {
  await assertRejects(
    () => resolveSecret("@file=/tmp/nonexistent-webhook-secret-758"),
    Error,
    "could not be read",
  );
});

Deno.test("resolveSecret: throws for an empty file", async () => {
  const tmpFile = Deno.makeTempFileSync();
  try {
    Deno.writeTextFileSync(tmpFile, "");
    await assertRejects(
      () => resolveSecret(`@file=${tmpFile}`),
      Error,
      "is empty",
    );
  } finally {
    Deno.removeSync(tmpFile);
  }
});

Deno.test("resolveSecret: throws for a file containing only a newline", async () => {
  const tmpFile = Deno.makeTempFileSync();
  try {
    Deno.writeTextFileSync(tmpFile, "\n");
    await assertRejects(
      () => resolveSecret(`@file=${tmpFile}`),
      Error,
      "is empty",
    );
  } finally {
    Deno.removeSync(tmpFile);
  }
});

// ── resolveSecret: @vault= ──────────────────────────────────────────

function createMockVault(
  secrets: Record<string, Record<string, string>>,
): VaultSecretResolver {
  return {
    get(vaultName: string, secretKey: string): Promise<string> {
      const vault = secrets[vaultName];
      if (!vault) {
        return Promise.reject(new Error(`Vault '${vaultName}' not found`));
      }
      const value = vault[secretKey];
      if (value === undefined) {
        return Promise.reject(
          new Error(`Key '${secretKey}' not found in vault '${vaultName}'`),
        );
      }
      return Promise.resolve(value);
    },
  };
}

Deno.test("resolveSecret: resolves @vault= from vault service", async () => {
  const vault = createMockVault({
    forgejo: { "webhook-secret": "vault-value" },
  });
  assertEquals(
    await resolveSecret("@vault=forgejo:webhook-secret", vault),
    "vault-value",
  );
});

Deno.test("resolveSecret: throws for @vault= with no vault service", async () => {
  await assertRejects(
    () => resolveSecret("@vault=forgejo:webhook-secret"),
    Error,
    "no vault service is available. Ensure a vault is configured",
  );
});

Deno.test("resolveSecret: throws for @vault= with missing colon separator", async () => {
  const vault = createMockVault({});
  await assertRejects(
    () => resolveSecret("@vault=forgejo", vault),
    Error,
    "expected '@vault=<vault-name>:<key>'",
  );
});

Deno.test("resolveSecret: throws for @vault= with empty key", async () => {
  const vault = createMockVault({});
  await assertRejects(
    () => resolveSecret("@vault=forgejo:", vault),
    Error,
    "key is empty",
  );
});

Deno.test("resolveSecret: throws for @vault= when vault get fails", async () => {
  const vault = createMockVault({});
  await assertRejects(
    () => resolveSecret("@vault=nonexistent:key", vault),
    Error,
    "could not be resolved from vault",
  );
});

// ── parseWebhookFlag with secret indirection ──────────────────────────

Deno.test("parseWebhookFlag: resolves @env= secret in legacy form", async () => {
  Deno.env.set("TEST_WH_SECRET_LEGACY_758", "resolved-secret");
  try {
    const result = await parseWebhookFlag(
      "/hooks/gh:wf:@env=TEST_WH_SECRET_LEGACY_758",
    );
    assertEquals(result.secret, "resolved-secret");
    assertEquals(result.verifier, { scheme: "github" });
  } finally {
    Deno.env.delete("TEST_WH_SECRET_LEGACY_758");
  }
});

Deno.test("parseWebhookFlag: resolves @env= secret in scheme-qualified form", async () => {
  Deno.env.set("TEST_WH_SECRET_SCHEME_758", "resolved-secret");
  try {
    const result = await parseWebhookFlag(
      "/hooks/linear:wf:@env=TEST_WH_SECRET_SCHEME_758:linear",
    );
    assertEquals(result.secret, "resolved-secret");
    assertEquals(result.verifier, { scheme: "linear" });
  } finally {
    Deno.env.delete("TEST_WH_SECRET_SCHEME_758");
  }
});

Deno.test("parseWebhookFlag: resolves @file= secret", async () => {
  const tmpFile = Deno.makeTempFileSync();
  try {
    Deno.writeTextFileSync(tmpFile, "file-resolved\n");
    const result = await parseWebhookFlag(`/hooks/gh:wf:@file=${tmpFile}`);
    assertEquals(result.secret, "file-resolved");
  } finally {
    Deno.removeSync(tmpFile);
  }
});

// ── listEndpoints ─────────────────────────────────────────────────────

Deno.test("listEndpoints: includes scheme from each endpoint verifier", async () => {
  const service = new WebhookService({
    repoDir: "/tmp/fake",
    syncGate: undefined,
    // deno-lint-ignore no-explicit-any
    repoContext: {} as any,
    // deno-lint-ignore no-explicit-any
    datastoreConfig: {} as any,
    endpoints: await Promise.all([
      parseWebhookFlag("/hooks/gh:deploy:secret"),
      parseWebhookFlag("/hooks/stripe:billing:secret:stripe"),
      parseWebhookFlag("/hooks/custom:wf:secret:generic:X-Sig:sha256="),
    ]),
  });

  const infos = service.listEndpoints();
  assertEquals(infos.length, 3);
  assertEquals(infos[0].scheme, "github");
  assertEquals(infos[1].scheme, "stripe");
  assertEquals(infos[2].scheme, "generic");
});

// ── buildWebhookPayload header redaction ─────────────────────────────

Deno.test("buildWebhookPayload: strips authorization header", () => {
  const headers = new Headers({
    "Authorization": "Bearer secret-token",
    "Content-Type": "application/json",
  });
  const payload = buildWebhookPayload(
    new TextEncoder().encode("{}"),
    headers,
    "/test",
  );
  assertEquals("authorization" in payload.headers, false);
  assertEquals(payload.headers["content-type"], "application/json");
});

Deno.test("buildWebhookPayload: strips proxy-authorization header", () => {
  const headers = new Headers({
    "Proxy-Authorization": "Basic dXNlcjpwYXNz",
    "Content-Type": "application/json",
  });
  const payload = buildWebhookPayload(
    new TextEncoder().encode("{}"),
    headers,
    "/test",
  );
  assertEquals("proxy-authorization" in payload.headers, false);
  assertEquals(payload.headers["content-type"], "application/json");
});

Deno.test("buildWebhookPayload: strips cookie header", () => {
  const headers = new Headers({
    "Cookie": "session=abc123",
    "Content-Type": "application/json",
  });
  const payload = buildWebhookPayload(
    new TextEncoder().encode("{}"),
    headers,
    "/test",
  );
  assertEquals("cookie" in payload.headers, false);
  assertEquals(payload.headers["content-type"], "application/json");
});

Deno.test("buildWebhookPayload: strips x-api-key header", () => {
  const headers = new Headers({
    "X-Api-Key": "key-12345",
    "Content-Type": "application/json",
  });
  const payload = buildWebhookPayload(
    new TextEncoder().encode("{}"),
    headers,
    "/test",
  );
  assertEquals("x-api-key" in payload.headers, false);
  assertEquals(payload.headers["content-type"], "application/json");
});

Deno.test("buildWebhookPayload: strips x-amzn-oidc-accesstoken header", () => {
  const headers = new Headers({
    "X-Amzn-Oidc-Accesstoken": "eyJhbGciOi...",
    "Content-Type": "application/json",
  });
  const payload = buildWebhookPayload(
    new TextEncoder().encode("{}"),
    headers,
    "/test",
  );
  assertEquals("x-amzn-oidc-accesstoken" in payload.headers, false);
  assertEquals(payload.headers["content-type"], "application/json");
});

Deno.test("buildWebhookPayload: strips headers with -token suffix", () => {
  const headers = new Headers({
    "X-Custom-Token": "tok_abc",
    "Content-Type": "application/json",
  });
  const payload = buildWebhookPayload(
    new TextEncoder().encode("{}"),
    headers,
    "/test",
  );
  assertEquals("x-custom-token" in payload.headers, false);
  assertEquals(payload.headers["content-type"], "application/json");
});

Deno.test("buildWebhookPayload: strips headers with -secret suffix", () => {
  const headers = new Headers({
    "X-Custom-Secret": "s3cret",
    "Content-Type": "application/json",
  });
  const payload = buildWebhookPayload(
    new TextEncoder().encode("{}"),
    headers,
    "/test",
  );
  assertEquals("x-custom-secret" in payload.headers, false);
  assertEquals(payload.headers["content-type"], "application/json");
});

Deno.test("buildWebhookPayload: preserves standard event headers", () => {
  const headers = new Headers({
    "X-GitHub-Event": "push",
    "Content-Type": "application/json",
    "X-GitHub-Delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958",
  });
  const payload = buildWebhookPayload(
    new TextEncoder().encode("{}"),
    headers,
    "/test",
  );
  assertEquals(payload.headers["x-github-event"], "push");
  assertEquals(payload.headers["content-type"], "application/json");
  assertEquals(
    payload.headers["x-github-delivery"],
    "72d3162e-cc78-11e3-81ab-4c9367dc0958",
  );
});

Deno.test("buildWebhookPayload: preserves idempotency-key header", () => {
  const headers = new Headers({
    "Idempotency-Key": "unique-key-123",
    "Content-Type": "application/json",
  });
  const payload = buildWebhookPayload(
    new TextEncoder().encode("{}"),
    headers,
    "/test",
  );
  assertEquals(payload.headers["idempotency-key"], "unique-key-123");
});

// ── isSensitiveHeader ────────────────────────────────────────────────

Deno.test("isSensitiveHeader: returns true for known sensitive headers", () => {
  const sensitiveHeaders = [
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "x-auth-token",
    "x-hub-signature",
    "x-shopify-hmac-sha256",
    "x-amzn-oidc-accesstoken",
    "x-amzn-oidc-data",
    "x-goog-iap-jwt-assertion",
    "cf-access-jwt-assertion",
    "x-forwarded-client-cert",
  ];
  for (const header of sensitiveHeaders) {
    assertEquals(
      isSensitiveHeader(header),
      true,
      `expected ${header} to be sensitive`,
    );
  }
});

Deno.test("isSensitiveHeader: returns false for safe headers", () => {
  const safeHeaders = [
    "content-type",
    "x-github-event",
    "idempotency-key",
  ];
  for (const header of safeHeaders) {
    assertEquals(
      isSensitiveHeader(header),
      false,
      `expected ${header} to be safe`,
    );
  }
});

// ── Extension webhook schemes ─────────────────────────────────────────

const TOKEN_HEADER = "x-test-secret-token";

/** Registers a uniquely named webhook extension type built from `handler`. */
function registerExtension(
  handler: Partial<WebhookHandler>,
  configSchema?: z.ZodTypeAny,
): ExtensionWebhookScheme {
  const type: ExtensionWebhookScheme = `@test/hook-${crypto.randomUUID()}`;
  webhookTypeRegistry.register({
    type,
    name: "Test hook",
    description: "Test webhook extension",
    configSchema,
    createHandler: () => ({
      signatureHeader: TOKEN_HEADER,
      requiredHeaders: [TOKEN_HEADER],
      verify: (_body, headers, secret) => headers.get(TOKEN_HEADER) === secret,
      ...handler,
    }),
  });
  return type;
}

function extensionService(scheme: ExtensionWebhookScheme): {
  service: WebhookService;
  pendingRuns: unknown[];
} {
  const pendingRuns: unknown[] = [];
  const service = new WebhookService({
    repoDir: "/tmp/fake",
    syncGate: undefined,
    repoContext: {} as unknown as RepositoryContext,
    datastoreConfig: {} as unknown as DatastoreConfig,
    endpoints: [{
      route: "/hooks/ext",
      workflowIdOrName: "wf",
      secret: "s3cret",
      verifier: { scheme, config: {} },
    }],
    runTracker: {
      enqueuePendingRun: (entry: unknown) => pendingRuns.push(entry),
    } as unknown as RunTrackerStore,
  });
  return { service, pendingRuns };
}

function extensionRequest(token?: string): Request {
  const headers: Record<string, string> = { "x-event": "update" };
  if (token !== undefined) headers[TOKEN_HEADER] = token;
  return new Request("http://localhost/hooks/ext", {
    method: "POST",
    headers,
    body: '{"update_id":1}',
  });
}

Deno.test("parseWebhookFlag: accepts a lowercased extension scheme with empty config", async () => {
  const ep = await parseWebhookFlag("/hooks/tg:wf:tok:@Swamp/Telegram");
  assertEquals(ep.secret, "tok");
  assertEquals(ep.verifier, { scheme: "@swamp/telegram", config: {} });
});

Deno.test("handleRequest: extension respond with enqueue false returns its response without a run", async () => {
  let seenHeaders: Record<string, string> = {};
  const type = registerExtension({
    transform: (body, headers) => {
      seenHeaders = headers;
      return { wrapped: body };
    },
    respond: (payload) => ({
      status: 202,
      body: { echoed: payload.body },
      enqueue: false,
    }),
  });
  const { service, pendingRuns } = extensionService(type);

  const res = await service.handleRequest(extensionRequest("s3cret"));

  assertEquals(res?.status, 202);
  assertEquals(await res!.json(), { echoed: { wrapped: { update_id: 1 } } });
  assertEquals(pendingRuns.length, 0);
  assertEquals(seenHeaders[TOKEN_HEADER], undefined);
  assertEquals(seenHeaders["x-event"], "update");
});

Deno.test("handleRequest: extension hooks never run when verification fails", async () => {
  let hookCalls = 0;
  const type = registerExtension({
    transform: (body) => {
      hookCalls++;
      return body;
    },
    respond: () => {
      hookCalls++;
      return { status: 200, body: "challenge", enqueue: false };
    },
  });
  const { service, pendingRuns } = extensionService(type);

  assertEquals(
    (await service.handleRequest(extensionRequest("wrong")))?.status,
    401,
  );
  assertEquals((await service.handleRequest(extensionRequest()))?.status, 401);
  assertEquals(hookCalls, 0);
  assertEquals(pendingRuns.length, 0);
});

Deno.test("handleRequest: a throwing or non-boolean extension verifier is rejected with 401", async () => {
  for (
    const verify of [
      () => {
        throw new Error("boom");
      },
      () => "yes" as unknown as boolean,
    ]
  ) {
    const { service } = extensionService(registerExtension({ verify }));
    const res = await service.handleRequest(extensionRequest("s3cret"));
    assertEquals(res?.status, 401);
    assertEquals(await res!.json(), { error: "Invalid signature" });
  }
});

Deno.test("handleRequest: failing extension hooks return a generic 500 with no pending run", async () => {
  const failing: Partial<WebhookHandler>[] = [
    {
      transform: () => {
        throw new Error("secret detail");
      },
    },
    { transform: () => ({ big: 1n }) },
    { respond: () => ({ status: 700, enqueue: false }) },
    { respond: () => ({ status: 101, enqueue: false }) },
    { respond: () => ({ status: 204, body: "x", enqueue: true }) },
  ];
  for (const handler of failing) {
    const { service, pendingRuns } = extensionService(
      registerExtension(handler),
    );
    const res = await service.handleRequest(extensionRequest("s3cret"));
    assertEquals(res?.status, 500);
    assertEquals(await res!.json(), { error: "Internal server error" });
    assertEquals(pendingRuns.length, 0);
  }
});

Deno.test("handleRequest: an unregistered extension type fails closed with 500", async () => {
  const { service, pendingRuns } = extensionService(
    `@test/missing-${crypto.randomUUID()}`,
  );
  const res = await service.handleRequest(extensionRequest("s3cret"));
  assertEquals(res?.status, 500);
  assertEquals(pendingRuns.length, 0);
});

function extensionEndpoint(
  scheme: ExtensionWebhookScheme,
  config: Record<string, unknown>,
): WebhookEndpoint {
  return {
    route: "/hooks/ext",
    workflowIdOrName: "wf",
    secret: "s",
    verifier: { scheme, config },
  };
}

Deno.test("resolveExtensionWebhookEndpoints: applies the type's configSchema", async () => {
  const type = registerExtension(
    {},
    z.object({ header: z.string().default("x-default") }),
  );
  const [ep] = await resolveExtensionWebhookEndpoints(
    [extensionEndpoint(type, {})],
    () => Promise.resolve(true),
  );
  assertEquals(ep.verifier, { scheme: type, config: { header: "x-default" } });
});

Deno.test("resolveExtensionWebhookEndpoints: rejects invalid config", async () => {
  const type = registerExtension({}, z.object({ header: z.string() }));
  await assertRejects(
    () =>
      resolveExtensionWebhookEndpoints(
        [extensionEndpoint(type, { header: 1 })],
        () => Promise.resolve(true),
      ),
    UserError,
    "Invalid config for webhook /hooks/ext",
  );
});

Deno.test("resolveExtensionWebhookEndpoints: rejects an unresolvable type", async () => {
  await assertRejects(
    () =>
      resolveExtensionWebhookEndpoints(
        [extensionEndpoint("@test/nope", {})],
        () => Promise.resolve(false),
      ),
    UserError,
    "no webhook extension of that type is installed",
  );
});

Deno.test("resolveExtensionWebhookEndpoints: leaves built-in endpoints untouched", async () => {
  const builtin = await parseWebhookFlag("/hooks/gh:deploy:secret");
  const resolved = await resolveExtensionWebhookEndpoints(
    [builtin],
    () => Promise.reject(new Error("should not resolve")),
  );
  assertEquals(resolved, [builtin]);
});

// ── updateEndpoints ─────────────────────────────────────────────────

Deno.test("updateEndpoints: swaps active endpoints and returns change count", async () => {
  const ep1 = await parseWebhookFlag("/hooks/a:wf-a:secret-a");
  const ep2 = await parseWebhookFlag("/hooks/b:wf-b:secret-b");
  const service = new WebhookService({
    repoDir: "/tmp/fake",
    syncGate: undefined,
    repoContext: {} as RepositoryContext,
    datastoreConfig: {} as DatastoreConfig,
    endpoints: [ep1],
  });

  assertEquals(service.listEndpoints().length, 1);
  assertEquals(service.listEndpoints()[0].route, "/hooks/a");

  const changed = service.updateEndpoints([ep2]);

  assertEquals(changed, 2);
  assertEquals(service.listEndpoints().length, 1);
  assertEquals(service.listEndpoints()[0].route, "/hooks/b");
});

Deno.test("updateEndpoints: returns 0 when endpoints are unchanged", async () => {
  const ep = await parseWebhookFlag("/hooks/a:wf:secret");
  const service = new WebhookService({
    repoDir: "/tmp/fake",
    syncGate: undefined,
    repoContext: {} as RepositoryContext,
    datastoreConfig: {} as DatastoreConfig,
    endpoints: [ep],
  });

  const changed = service.updateEndpoints([ep]);
  assertEquals(changed, 0);
});

Deno.test("updateEndpoints: detects workflow binding change on same route", async () => {
  const ep1 = await parseWebhookFlag("/hooks/a:wf-old:secret");
  const ep2 = await parseWebhookFlag("/hooks/a:wf-new:secret");
  const service = new WebhookService({
    repoDir: "/tmp/fake",
    syncGate: undefined,
    repoContext: {} as RepositoryContext,
    datastoreConfig: {} as DatastoreConfig,
    endpoints: [ep1],
  });

  const changed = service.updateEndpoints([ep2]);

  assertEquals(changed, 1);
  assertEquals(service.listEndpoints()[0].workflowIdOrName, "wf-new");
});

Deno.test("updateEndpoints: clears all endpoints when given empty list", async () => {
  const ep = await parseWebhookFlag("/hooks/a:wf:secret");
  const service = new WebhookService({
    repoDir: "/tmp/fake",
    syncGate: undefined,
    repoContext: {} as RepositoryContext,
    datastoreConfig: {} as DatastoreConfig,
    endpoints: [ep],
  });

  const changed = service.updateEndpoints([]);

  assertEquals(changed, 1);
  assertEquals(service.listEndpoints().length, 0);
});
