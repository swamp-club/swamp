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
  currentVaultAccess,
  RunVaultAccess,
  runWithVaultAccess,
} from "../domain/vaults/run_vault_access.ts";
import type { ServeRunVaultScope } from "./run_vault_access_policy.ts";
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { z } from "zod";
import { waitFor } from "@swamp-club/swamp-testing";
import { propagation, type Span, trace } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  installExecutionObserver,
  uninstallExecutionObserver,
} from "../infrastructure/tracing/execution_observer.ts";
import { withCapturedSpans } from "../infrastructure/tracing/span_test_helpers.ts";
import { withSpan } from "../infrastructure/tracing/mod.ts";
import {
  buildWebhookPayload,
  isSensitiveHeader,
  parseWebhookFlag,
  resolveExtensionWebhookEndpoints,
  resolveSecret,
  type WebhookEndpoint,
  type WebhookEvent,
  WebhookService,
} from "./webhook.ts";
import { hmacSha256Hex } from "./webhook_verifiers.ts";
import type { VaultSecretResolver } from "./webhook.ts";
import { initializeLogging } from "../infrastructure/logging/logger.ts";
import { withMockedEnv } from "../infrastructure/persistence/path_test_helpers.ts";
import { UserError } from "../domain/errors.ts";
import type { WebhookHandler } from "../domain/webhooks/webhook_handler.ts";
import type { ExtensionWebhookScheme } from "./webhook_verifiers.ts";
import { webhookTypeRegistry } from "../domain/webhooks/webhook_type_registry.ts";
import type { RunTrackerStore } from "../infrastructure/persistence/run_tracker_store.ts";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import type { DatastoreConfig } from "../domain/datastore/datastore_config.ts";
import type { ControlPlaneStore } from "../domain/datastore/control_plane_store.ts";

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
  await withMockedEnv(
    { TEST_WEBHOOK_SECRET_758: "env-secret-value" },
    async () => {
      assertEquals(
        await resolveSecret("@env=TEST_WEBHOOK_SECRET_758"),
        "env-secret-value",
      );
    },
  );
});

Deno.test("resolveSecret: throws for an unset environment variable", async () => {
  await withMockedEnv({ NONEXISTENT_WEBHOOK_VAR_758: undefined }, async () => {
    await assertRejects(
      () => resolveSecret("@env=NONEXISTENT_WEBHOOK_VAR_758"),
      Error,
      "not set or is empty",
    );
  });
});

Deno.test("resolveSecret: throws for an empty environment variable", async () => {
  await withMockedEnv({ EMPTY_WEBHOOK_VAR_758: "" }, async () => {
    await assertRejects(
      () => resolveSecret("@env=EMPTY_WEBHOOK_VAR_758"),
      Error,
      "not set or is empty",
    );
  });
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
  await withMockedEnv(
    { TEST_WH_SECRET_LEGACY_758: "resolved-secret" },
    async () => {
      const result = await parseWebhookFlag(
        "/hooks/gh:wf:@env=TEST_WH_SECRET_LEGACY_758",
      );
      assertEquals(result.secret, "resolved-secret");
      assertEquals(result.verifier, { scheme: "github" });
    },
  );
});

Deno.test("parseWebhookFlag: resolves @env= secret in scheme-qualified form", async () => {
  await withMockedEnv(
    { TEST_WH_SECRET_SCHEME_758: "resolved-secret" },
    async () => {
      const result = await parseWebhookFlag(
        "/hooks/linear:wf:@env=TEST_WH_SECRET_SCHEME_758:linear",
      );
      assertEquals(result.secret, "resolved-secret");
      assertEquals(result.verifier, { scheme: "linear" });
    },
  );
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

// ── drain (swamp-club#2484) ──────────────────────────────────────────

Deno.test("WebhookService.drain: matched routes get 503 with Retry-After while unmatched stay null", async () => {
  const service = new WebhookService({
    repoDir: "/tmp/fake",
    syncGate: undefined,
    // deno-lint-ignore no-explicit-any
    repoContext: {} as any,
    // deno-lint-ignore no-explicit-any
    datastoreConfig: {} as any,
    endpoints: [await parseWebhookFlag("/hooks/gh:deploy:secret")],
  });
  const rejections: string[] = [];
  service.setEventHandler((event) => {
    if (event.kind === "webhook_rejected") rejections.push(event.reason);
  });

  await service.drain(0);

  const response = await service.handleRequest(
    new Request("http://localhost/hooks/gh", { method: "POST", body: "{}" }),
  );
  assertEquals(response?.status, 503);
  assertEquals(response?.headers.get("retry-after"), "5");
  assertStringIncludes(
    (await response!.json()).error,
    "shutting down",
  );
  assertEquals(rejections, ["Server shutting down"]);

  const unmatched = await service.handleRequest(
    new Request("http://localhost/hooks/other", { method: "POST" }),
  );
  assertEquals(unmatched, null);
  await service.stop();
});

Deno.test("WebhookService.drain: with no in-flight run resolves and stop still succeeds", async () => {
  const service = new WebhookService({
    repoDir: "/tmp/fake",
    syncGate: undefined,
    // deno-lint-ignore no-explicit-any
    repoContext: {} as any,
    // deno-lint-ignore no-explicit-any
    datastoreConfig: {} as any,
    endpoints: [],
  });
  await service.drain(60_000);
  await service.stop();
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

Deno.test("handleRequest: a drain starting during the hooks turns the delivery away before it is queued", async () => {
  const gate = Promise.withResolvers<void>();
  let transforming = false;
  const type = registerExtension({
    transform: async (body) => {
      transforming = true;
      await gate.promise;
      return body;
    },
  });
  const { service, pendingRuns } = extensionService(type);

  const pending = service.handleRequest(extensionRequest("s3cret"));
  await waitFor(() => transforming, "transform hook to start");
  await service.drain(0);
  gate.resolve();
  const res = await pending;

  assertEquals(res?.status, 503);
  assertEquals(res?.headers.get("retry-after"), "5");
  await res?.body?.cancel();
  assertEquals(pendingRuns.length, 0);
  await service.stop();
});

Deno.test("WebhookService.drain: waits for dropped entries' control-plane writes and starts no dequeued run", async () => {
  const type = registerExtension({});
  const putGate = Promise.withResolvers<void>();
  const puts: string[] = [];
  const remoteDeletes: string[] = [];
  const localDeletes: string[] = [];
  const service = new WebhookService({
    repoDir: "/tmp/fake",
    syncGate: undefined,
    repoContext: {} as unknown as RepositoryContext,
    datastoreConfig: {} as unknown as DatastoreConfig,
    endpoints: [{
      route: "/hooks/ext",
      workflowIdOrName: "wf",
      secret: "s3cret",
      verifier: { scheme: type, config: {} },
    }],
    runTracker: {
      enqueuePendingRun: () => {},
      deletePendingRun: (id: string) => localDeletes.push(id),
    } as unknown as RunTrackerStore,
    controlPlaneStore: {
      put: (key: string) => {
        puts.push(key);
        return putGate.promise;
      },
      delete: (key: string) => {
        remoteDeletes.push(key);
        return Promise.resolve();
      },
    } as unknown as ControlPlaneStore,
  });

  // The first delivery is dequeued and waits on its put; the second queues
  // behind it.
  for (let i = 0; i < 2; i++) {
    const res = await service.handleRequest(extensionRequest("s3cret"));
    assertEquals(res?.status, 200);
    await res?.body?.cancel();
  }
  assertEquals(puts.length, 2);

  const order: string[] = [];
  const drain = service.drain(0).then(() => order.push("drained"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  order.push("released");
  putGate.resolve();
  await drain;
  await service.stop();

  assertEquals(order, ["released", "drained"]);
  // Neither entry started, so both stay pending for the next boot.
  assertEquals(localDeletes, []);
  assertEquals(remoteDeletes, []);
  assertEquals(service.queueStatus("/hooks/ext").active, 0);
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
  const error = await assertRejects(
    () =>
      resolveExtensionWebhookEndpoints(
        [extensionEndpoint("@test/nope", {})],
        () => Promise.resolve(false),
      ),
    UserError,
    "no installed extension provides that webhook type",
  );
  // The scheme is a type, not an extension name (swamp-club#2476).
  assertEquals(error.message.includes("extension pull @test/nope"), false);
  assertStringIncludes(error.message, "swamp extension search");
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

// ── service principal, authorization and audit events (swamp-club#2464) ──

type ExecutorCall = {
  input: { workflowIdOrName: string; initiatedBy?: string };
  options: { triggerSource?: string; initiatedBy?: string };
};

function recordingExecutor(calls: ExecutorCall[]) {
  return ((
    _repoDir: string,
    _repoContext: unknown,
    _datastoreConfig: unknown,
    input: ExecutorCall["input"],
    _signal: AbortSignal,
    onEvent: (event: unknown) => void,
    _syncService: unknown,
    _runTracker: unknown,
    options: ExecutorCall["options"],
  ) => {
    calls.push({ input, options });
    onEvent({ kind: "started", runId: `run-${calls.length}` });
    onEvent({ kind: "completed", run: { status: "succeeded" } });
    return Promise.resolve();
  }) as unknown as NonNullable<
    ConstructorParameters<typeof WebhookService>[0]["executeWorkflow"]
  >;
}

function signedDelivery(body: string): Promise<Request> {
  return signedDeliveryTo("/hooks/gh", body);
}

async function signedDeliveryTo(route: string, body: string): Promise<Request> {
  const signature = await hmacSha256Hex(
    new TextEncoder().encode(body),
    "secret",
  );
  return new Request(`http://localhost${route}`, {
    method: "POST",
    body,
    headers: { "x-hub-signature-256": `sha256=${signature}` },
  });
}

async function triggerService(
  overrides: Partial<ConstructorParameters<typeof WebhookService>[0]> = {},
) {
  const calls: ExecutorCall[] = [];
  const events: WebhookEvent[] = [];
  const service = new WebhookService({
    repoDir: "/tmp/fake",
    syncGate: undefined,
    // deno-lint-ignore no-explicit-any
    repoContext: {} as any,
    // deno-lint-ignore no-explicit-any
    datastoreConfig: {} as any,
    endpoints: [await parseWebhookFlag("/hooks/gh:deploy:secret")],
    initiatedBy: "service:webhook",
    executeWorkflow: recordingExecutor(calls),
    ...overrides,
  });
  service.setEventHandler((event) => events.push(event));
  return { service, calls, events };
}

Deno.test("WebhookService: a verified delivery runs as service:webhook with an unchanged response", async () => {
  const { service, calls, events } = await triggerService();
  const response = await service.handleRequest(
    await signedDelivery('{"ref":"main"}'),
    "203.0.113.9",
  );
  assertEquals(response?.status, 200);
  assertEquals(await response!.json(), {
    status: "queued",
    workflow: "deploy",
  });
  await waitFor(() => calls.length === 1, "run executed");
  await service.stop();

  assertEquals(calls[0].input.initiatedBy, "service:webhook");
  assertEquals(calls[0].options.initiatedBy, "service:webhook");
  assertEquals(calls[0].options.triggerSource, "webhook");
  const started = events.find((e) => e.kind === "webhook_started");
  assertEquals(started, {
    kind: "webhook_started",
    route: "/hooks/gh",
    workflowName: "deploy",
    runId: "run-1",
    sourceIp: "203.0.113.9",
    replayed: false,
  });
  assertEquals(events.some((e) => e.kind === "webhook_completed"), true);
});

Deno.test("WebhookService: runs the authorized workflow and keeps the configured name in events", async () => {
  const { service, calls, events } = await triggerService({
    authorizeRun: () =>
      Promise.resolve({ allowed: true, workflowIdOrName: "deploy-canonical" }),
  });
  await service.handleRequest(await signedDelivery("{}"));
  await waitFor(() => calls.length === 1, "run executed");
  await service.stop();

  assertEquals(calls[0].input.workflowIdOrName, "deploy-canonical");
  const started = events.find((e) => e.kind === "webhook_started");
  assertEquals(
    started?.kind === "webhook_started" && started.workflowName,
    "deploy-canonical",
  );
  const completed = events.find((e) => e.kind === "webhook_completed");
  assertEquals(
    completed?.kind === "webhook_completed" && completed.workflowName,
    "deploy",
  );
});

Deno.test("WebhookService: a refused run never executes and the sender still gets queued", async () => {
  const { service, calls, events } = await triggerService({
    authorizeRun: (request) =>
      Promise.resolve({
        allowed: false,
        workflowIdOrName: request.workflowIdOrName,
        reason: "denied",
      }),
  });
  const response = await service.handleRequest(
    await signedDelivery("{}"),
    "203.0.113.9",
  );
  assertEquals(response?.status, 200);
  await waitFor(
    () => events.some((e) => e.kind === "webhook_denied"),
    "webhook_denied event",
  );
  await service.stop();
  assertEquals(calls.length, 0);
  const denied = events.find((e) => e.kind === "webhook_denied");
  assertEquals(
    denied?.kind === "webhook_denied" && denied.sourceIp,
    "203.0.113.9",
  );
});

Deno.test("WebhookService: a throwing authorizer refuses that run and the queue keeps going", async () => {
  let attempts = 0;
  const { service, calls, events } = await triggerService({
    authorizeRun: (request) => {
      attempts++;
      return attempts === 1
        ? Promise.reject(new Error("policy exploded"))
        : Promise.resolve({
          allowed: true,
          workflowIdOrName: request.workflowIdOrName,
        });
    },
  });
  await service.handleRequest(await signedDelivery("{}"));
  await service.handleRequest(await signedDelivery("{}"));
  await waitFor(() => calls.length === 1, "second run executed");
  await service.stop();

  const denied = events.find((e) => e.kind === "webhook_denied");
  assertEquals(
    denied?.kind === "webhook_denied" &&
      denied.reason.includes("policy exploded"),
    true,
  );
});

Deno.test("WebhookService: replayed deliveries are authorized as replayed", async () => {
  const requests: { replayed: boolean; sourceIp?: string }[] = [];
  const { service, calls, events } = await triggerService({
    authorizeRun: (request) => {
      requests.push({ replayed: request.replayed, sourceIp: request.sourceIp });
      return Promise.resolve({
        allowed: true,
        workflowIdOrName: request.workflowIdOrName,
      });
    },
  });
  service.enqueueForReplay({
    pendingRunId: "p-1",
    workflowIdOrName: "deploy",
    route: "/hooks/gh",
    payload: buildWebhookPayload(new Uint8Array(), new Headers(), "/hooks/gh"),
  });
  await waitFor(() => calls.length === 1, "replayed run executed");
  await service.stop();

  assertEquals(requests, [{ replayed: true, sourceIp: undefined }]);
  const started = events.find((e) => e.kind === "webhook_started");
  assertEquals(started?.kind === "webhook_started" && started.replayed, true);
});

Deno.test("WebhookService: rejections carry the source address and configured workflow", async () => {
  const { service, events } = await triggerService();
  const response = await service.handleRequest(
    new Request("http://localhost/hooks/gh", {
      method: "POST",
      body: "{}",
      headers: { "x-hub-signature-256": "sha256=00" },
    }),
    "198.51.100.7",
  );
  assertEquals(response?.status, 401);
  assertEquals(await response!.json(), { error: "Invalid signature" });
  await service.stop();

  const rejected = events.find((e) => e.kind === "webhook_rejected");
  assertEquals(rejected, {
    kind: "webhook_rejected",
    route: "/hooks/gh",
    workflowName: "deploy",
    reason: "Invalid signature",
    sourceIp: "198.51.100.7",
  });
});

Deno.test("WebhookService: a nested workflow's started event does not retarget the run (swamp-club#2470)", async () => {
  const calls: unknown[] = [];
  const { service, events } = await triggerService({
    executeWorkflow: ((
      _repoDir: string,
      _repoContext: unknown,
      _datastoreConfig: unknown,
      _input: unknown,
      _signal: AbortSignal,
      onEvent: (event: unknown) => void,
    ) => {
      calls.push(true);
      onEvent({ kind: "started", runId: "parent-1" });
      onEvent({ kind: "started", runId: "child-1", parentRunId: "parent-1" });
      onEvent({ kind: "completed", run: { status: "succeeded" } });
      return Promise.resolve();
    }) as unknown as NonNullable<
      ConstructorParameters<typeof WebhookService>[0]["executeWorkflow"]
    >,
  });
  await service.handleRequest(await signedDelivery("{}"));
  await waitFor(
    () => events.some((e) => e.kind === "webhook_completed"),
    "run completed",
  );
  await service.stop();

  assertEquals(calls.length, 1);
  const started = events.filter((e) => e.kind === "webhook_started");
  assertEquals(started.length, 1);
  assertEquals(
    started[0].kind === "webhook_started" && started[0].runId,
    "parent-1",
  );
  const completed = events.find((e) => e.kind === "webhook_completed");
  assertEquals(
    completed?.kind === "webhook_completed" && completed.runId,
    "parent-1",
  );
});

// ── trace context of queued runs (swamp-club#2467) ──

Deno.test("WebhookService: telemetry distinguishes queued receipt from refused execution", async () => {
  await withCapturedSpans(async (spans) => {
    installExecutionObserver();
    const { service, calls, events } = await triggerService({
      authorizeRun: () =>
        Promise.resolve({
          allowed: false,
          workflowIdOrName: "deploy",
          reason: "private policy detail",
        }),
    });
    try {
      await service.handleRequest(await signedDelivery("{}"));
      await waitFor(
        () => events.some((e) => e.kind === "webhook_denied"),
        "run refused",
      );
      await service.stop();
      assertEquals(calls.length, 0);
      const run = spans.find((s) => s.name === "swamp.webhook.run")!;
      assertEquals(run.attributes["swamp.outcome"], "error");
      assertEquals(
        run.attributes["swamp.webhook.rejection"],
        "authorization_denied",
      );
      assertEquals(
        JSON.stringify(run.attributes).includes("private policy detail"),
        false,
      );
      const receipt = spans.find((s) => s.name === "swamp.webhook.receipt")!;
      assertEquals(receipt.attributes["swamp.outcome"], "ok");
    } finally {
      await service.stop();
      uninstallExecutionObserver();
    }
  });
});

Deno.test("WebhookService: telemetry links replay to its receipt without inheriting boot context", async () => {
  await withCapturedSpans(async (spans) => {
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    installExecutionObserver();
    const { service, calls } = await triggerService();
    try {
      const receiptId = crypto.randomUUID();
      const traceId = "0af7651916cd43dd8448eb211c80319c";
      const spanId = "b7ad6b7169203331";
      await withSpan("boot", {}, () => {
        service.enqueueForReplay({
          pendingRunId: receiptId,
          workflowIdOrName: "deploy",
          route: "/hooks/gh",
          payload: { body: null, headers: {}, route: "/hooks/gh" },
          receiptTrace: { traceparent: `00-${traceId}-${spanId}-01` },
        });
        return Promise.resolve();
      });
      await waitFor(() => calls.length === 1, "replay executed");
      await service.stop();
      const run = spans.find((s) => s.name === "swamp.webhook.run")!;
      assertEquals(run.parentSpanId, undefined);
      assertEquals(
        run.links.map((link) => ({
          traceId: link.context.traceId,
          spanId: link.context.spanId,
        })),
        [{ traceId, spanId }],
      );
      assertEquals(run.attributes["swamp.webhook.receipt_id"], receiptId);
      assertEquals(run.attributes["swamp.webhook.replayed"], true);
      assertEquals(run.attributes["swamp.outcome"], "ok");
      const queue = spans.find((s) => s.name === "swamp.webhook.queue")!;
      assertEquals(queue.parentSpanId, spanId);
      assertEquals(queue.spanContext().traceId, traceId);
    } finally {
      await service.stop();
      uninstallExecutionObserver();
      propagation.disable();
    }
  });
});

Deno.test("WebhookService: malformed replay receipt metadata does not reject execution", async () => {
  await withCapturedSpans(async (spans) => {
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    installExecutionObserver();
    const { service, calls } = await triggerService();
    try {
      service.enqueueForReplay({
        pendingRunId: crypto.randomUUID(),
        workflowIdOrName: "deploy",
        route: "/hooks/gh",
        payload: { body: null, headers: {}, route: "/hooks/gh" },
        receiptTrace: { traceparent: "malformed" },
      });
      await waitFor(() => calls.length === 1, "replay executed");
      await service.stop();
      const run = spans.find((span) => span.name === "swamp.webhook.run")!;
      assertEquals(run.links, []);
      assertEquals(run.attributes["swamp.outcome"], "ok");
    } finally {
      await service.stop();
      uninstallExecutionObserver();
      propagation.disable();
    }
  });
});

/** An executor that records the span active when each run starts. */
function spanRecordingExecutor(seen: (Span | undefined)[]) {
  return ((
    _repoDir: string,
    _repoContext: unknown,
    _datastoreConfig: unknown,
    _input: unknown,
    _signal: AbortSignal,
    onEvent: (event: unknown) => void,
  ) => {
    seen.push(trace.getActiveSpan());
    onEvent({ kind: "started", runId: `run-${seen.length}` });
    onEvent({ kind: "completed", run: { status: "succeeded" } });
    return Promise.resolve();
  }) as unknown as NonNullable<
    ConstructorParameters<typeof WebhookService>[0]["executeWorkflow"]
  >;
}

Deno.test("WebhookService: queued runs do not inherit the span of the request that started the queue", async () => {
  await withCapturedSpans(async () => {
    const seen: (Span | undefined)[] = [];
    const { service } = await triggerService({
      executeWorkflow: spanRecordingExecutor(seen),
    });
    // Each delivery arrives inside its own request span, as traceHttpRequests
    // wraps it; the first one starts the queue processor.
    for (const route of ["first", "second"]) {
      await withSpan(`POST /hooks/gh ${route}`, {}, async () => {
        await service.handleRequest(await signedDelivery("{}"));
      });
    }
    await waitFor(() => seen.length === 2, "both runs executed");
    await service.stop();

    assertEquals(seen, [undefined, undefined]);
  });
});

Deno.test("WebhookService: a replayed run does not inherit the span active at boot", async () => {
  await withCapturedSpans(async () => {
    const seen: (Span | undefined)[] = [];
    const { service } = await triggerService({
      executeWorkflow: spanRecordingExecutor(seen),
    });
    // Boot reconciliation replays inside serve's never-ending swamp.cli span.
    await withSpan("swamp.cli", {}, () => {
      service.enqueueForReplay({
        pendingRunId: crypto.randomUUID(),
        workflowIdOrName: "deploy",
        route: "/hooks/gh",
        payload: { body: null, headers: {}, route: "/hooks/gh" },
      });
      return Promise.resolve();
    });
    await waitFor(() => seen.length === 1, "replayed run executed");
    await service.stop();

    assertEquals(seen, [undefined]);
  });
});

Deno.test("WebhookService: a delivery's traceparent still reaches the run", async () => {
  const { service, calls } = await triggerService();
  const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
  const request = await signedDelivery("{}");
  request.headers.set("traceparent", traceparent);
  await withSpan("POST /hooks/gh", {}, () => service.handleRequest(request));
  await waitFor(() => calls.length === 1, "run executed");
  await service.stop();

  assertEquals(
    (calls[0].input as { traceparent?: string }).traceparent,
    traceparent,
  );
});

Deno.test("WebhookService: each queued run gets its own vault scope and starts outside any other (swamp-club#2676)", async () => {
  const scopes: ServeRunVaultScope[] = [];
  const seen: { passed: unknown; ambient: unknown }[] = [];
  const outer = RunVaultAccess.create({ allowedVaults: ["leaked"] });
  const { service } = await triggerService({
    createVaultAccess: () => {
      const scope = { access: RunVaultAccess.create({}) };
      scopes.push(scope);
      return scope;
    },
    executeWorkflow: ((
      ..._args: unknown[]
    ) => {
      const options = _args[8] as { vaultAccess?: unknown };
      seen.push({
        passed: options.vaultAccess,
        ambient: currentVaultAccess(),
      });
      return Promise.resolve();
    }) as unknown as NonNullable<
      ConstructorParameters<typeof WebhookService>[0]["executeWorkflow"]
    >,
  });
  // A delivery that arrives inside some scope must not hand it to the queue.
  await runWithVaultAccess(outer, async () => {
    await service.handleRequest(await signedDelivery("{}"));
    await service.handleRequest(await signedDelivery("{}"));
  });
  await waitFor(() => seen.length === 2, "both runs executed");
  await service.stop();
  assertEquals(scopes.length, 2);
  assertEquals(seen[0].passed, scopes[0]);
  assertEquals(seen[1].passed, scopes[1]);
  assertEquals(seen.map((s) => s.ambient), [undefined, undefined]);
});

/**
 * An executor whose run starts as `runId`, with a nested child, and settles as
 * cancelled once its signal aborts. `aborts` receives each abort reason.
 */
function cancellableExecutor(runId: string, aborts: unknown[]) {
  return ((
    _repoDir: string,
    _repoContext: unknown,
    _datastoreConfig: unknown,
    _input: unknown,
    signal: AbortSignal,
    onEvent: (event: unknown) => void,
  ) => {
    onEvent({ kind: "started", runId });
    onEvent({ kind: "started", runId: `${runId}-child`, parentRunId: runId });
    return new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => {
        aborts.push(signal.reason);
        onEvent({ kind: "cancelled", run: { status: "cancelled" } });
        resolve();
      }, { once: true });
    });
  }) as unknown as NonNullable<
    ConstructorParameters<typeof WebhookService>[0]["executeWorkflow"]
  >;
}

Deno.test("WebhookService.cancelByRunId: aborts the in-flight run with the reason and settles it as cancelled (swamp-club#3740)", async () => {
  const aborts: unknown[] = [];
  const { service, events } = await triggerService({
    executeWorkflow: cancellableExecutor("run-1", aborts),
  });
  await service.handleRequest(await signedDelivery("{}"));
  await waitFor(
    () => events.some((e) => e.kind === "webhook_started"),
    "run started",
  );

  assertEquals(service.cancelByRunId("other-run"), false);
  // A nested run is cancelled through its parent, not by its own id.
  assertEquals(service.cancelByRunId("run-1-child"), false);
  assertEquals(service.cancelByRunId("run-1", "no longer needed"), true);

  await waitFor(
    () => events.some((e) => e.kind === "webhook_failed"),
    "run settled",
  );
  assertEquals(aborts.length, 1);
  assertEquals((aborts[0] as Error).message, "no longer needed");
  const failed = events.find((e) => e.kind === "webhook_failed");
  assertEquals(
    failed?.kind === "webhook_failed" && failed.error,
    "workflow was cancelled",
  );
  // A settled run is no longer held, so it cannot be cancelled again.
  assertEquals(service.cancelByRunId("run-1"), false);
  await service.stop();
});

Deno.test("WebhookService.cancelAllRuns: aborts every in-flight run and counts them (swamp-club#3740)", async () => {
  const aborts: unknown[] = [];
  const { service, events } = await triggerService({
    executeWorkflow: cancellableExecutor("run-1", aborts),
  });
  assertEquals(service.cancelAllRuns(), 0);
  await service.handleRequest(await signedDelivery("{}"));
  await waitFor(
    () => events.some((e) => e.kind === "webhook_started"),
    "run started",
  );

  assertEquals(service.cancelAllRuns("shutting it all down"), 1);
  await waitFor(() => aborts.length === 1, "run aborted");
  assertEquals((aborts[0] as Error).message, "shutting it all down");
  await service.stop();
});

Deno.test("WebhookService.cancelByRunId: a run whose start is not recorded yet is not matched (swamp-club#3740)", async () => {
  let entered = false;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const { service } = await triggerService({
    executeWorkflow: (async () => {
      entered = true;
      await gate;
    }) as unknown as NonNullable<
      ConstructorParameters<typeof WebhookService>[0]["executeWorkflow"]
    >,
  });
  await service.handleRequest(await signedDelivery("{}"));
  await waitFor(() => entered, "run entered");

  assertEquals(service.cancelByRunId(""), false);
  assertEquals(service.cancelByRunId("run-1"), false);
  release();
  await service.stop();
});

// ── concurrent webhook runs (swamp-club#3665) ──

type GatedRun = {
  input: {
    workflowIdOrName: string;
    traceparent?: string;
    webhook: { body: unknown };
  };
  signal: AbortSignal;
  vaultAccess: unknown;
  ambient: unknown;
  span: Span | undefined;
  release: () => void;
  fail: (error: Error) => void;
};

/** An executor whose runs stay in flight until the test releases them. */
function gatedExecutor() {
  const runs: GatedRun[] = [];
  const executor = ((
    _repoDir: string,
    _repoContext: unknown,
    _datastoreConfig: unknown,
    input: GatedRun["input"],
    signal: AbortSignal,
    onEvent: (event: unknown) => void,
    _syncService: unknown,
    _runTracker: unknown,
    options: { vaultAccess?: unknown },
  ) => {
    const gate = Promise.withResolvers<void>();
    signal.addEventListener(
      "abort",
      () => gate.reject(new DOMException("aborted", "AbortError")),
    );
    runs.push({
      input,
      signal,
      vaultAccess: options.vaultAccess,
      ambient: currentVaultAccess(),
      span: trace.getActiveSpan(),
      release: () => gate.resolve(),
      fail: (error) => gate.reject(error),
    });
    onEvent({ kind: "started", runId: `run-${runs.length}` });
    return gate.promise.then(() =>
      onEvent({ kind: "completed", run: { status: "succeeded" } })
    );
  }) as unknown as NonNullable<
    ConstructorParameters<typeof WebhookService>[0]["executeWorkflow"]
  >;
  return { runs, executor };
}

async function concurrentService(
  overrides: Partial<ConstructorParameters<typeof WebhookService>[0]> = {},
) {
  const { runs, executor } = gatedExecutor();
  const { service, events } = await triggerService({
    endpoints: [
      await parseWebhookFlag("/hooks/gh:deploy:secret"),
      await parseWebhookFlag("/hooks/alerts:triage:secret"),
    ],
    executeWorkflow: executor,
    ...overrides,
  });
  const completed = (runId: string) =>
    events.some((e) => e.kind === "webhook_completed" && e.runId === runId);
  return { service, events, runs, completed };
}

for (
  const [label, secondRoute] of [
    ["the same route", "/hooks/gh"],
    ["different routes", "/hooks/alerts"],
  ]
) {
  Deno.test(`WebhookService: a second delivery on ${label} completes while the first is still running`, async () => {
    const { service, runs, completed } = await concurrentService({
      maxConcurrentRuns: 2,
    });
    await service.handleRequest(await signedDeliveryTo("/hooks/gh", "{}"));
    await waitFor(() => runs.length === 1, "delivery A started");
    await service.handleRequest(await signedDeliveryTo(secondRoute, "{}"));
    await waitFor(() => runs.length === 2, "delivery B started");

    runs[1].release();
    await waitFor(() => completed("run-2"), "delivery B completed");
    assertEquals(completed("run-1"), false);

    runs[0].release();
    await waitFor(() => completed("run-1"), "delivery A completed");
    await service.stop();
  });
}

Deno.test("WebhookService: by default a delivery waits for the run ahead of it", async () => {
  const { service, runs, completed } = await concurrentService();
  await service.handleRequest(await signedDeliveryTo("/hooks/gh", "{}"));
  await waitFor(() => runs.length === 1, "delivery A started");
  await service.handleRequest(await signedDeliveryTo("/hooks/alerts", "{}"));

  assertEquals(service.queueStatus("/hooks/gh").active, 1);
  assertEquals(service.queueStatus("/hooks/alerts").queued, 1);
  assertEquals(runs.length, 1);

  runs[0].release();
  await waitFor(() => runs.length === 2, "delivery B started");
  assertEquals(completed("run-1"), true);
  runs[1].release();
  await waitFor(() => completed("run-2"), "delivery B completed");
  await service.stop();
});

Deno.test("WebhookService: a delivery beyond the limit starts when a run settles", async () => {
  const { service, runs } = await concurrentService({ maxConcurrentRuns: 2 });
  for (let i = 0; i < 3; i++) {
    await service.handleRequest(await signedDeliveryTo("/hooks/gh", "{}"));
  }
  await waitFor(() => runs.length === 2, "two runs started");
  assertEquals(service.queueStatus("/hooks/gh").active, 2);
  assertEquals(service.queueStatus("/hooks/gh").queued, 1);

  runs[1].release();
  await waitFor(() => runs.length === 3, "third run started");
  assertEquals(service.queueStatus("/hooks/gh").active, 2);
  assertEquals(service.queueStatus("/hooks/gh").queued, 0);
  runs[0].release();
  runs[2].release();
  await waitFor(
    () => service.queueStatus("/hooks/gh").active === 0,
    "all runs settled",
  );
  await service.stop();
});

Deno.test("WebhookService: a failing run frees its slot for the next delivery", async () => {
  const { service, events, runs, completed } = await concurrentService();
  await service.handleRequest(await signedDeliveryTo("/hooks/gh", "{}"));
  await waitFor(() => runs.length === 1, "first run started");
  await service.handleRequest(await signedDeliveryTo("/hooks/gh", "{}"));

  runs[0].fail(new Error("step exploded"));
  await waitFor(() => runs.length === 2, "second run started");
  runs[1].release();
  await waitFor(() => completed("run-2"), "second run completed");
  await service.stop();

  const failed = events.find((e) => e.kind === "webhook_failed");
  assertEquals(
    failed?.kind === "webhook_failed" && failed.error,
    "step exploded",
  );
  assertEquals(service.queueStatus("/hooks/gh").active, 0);
});

Deno.test("WebhookService: a refused run leaves no active run behind", async () => {
  const { service, events } = await concurrentService({
    maxConcurrentRuns: 2,
    authorizeRun: (request) =>
      Promise.resolve({
        allowed: false,
        workflowIdOrName: request.workflowIdOrName,
        reason: "denied",
      }),
  });
  await service.handleRequest(await signedDeliveryTo("/hooks/gh", "{}"));
  await waitFor(
    () => events.some((e) => e.kind === "webhook_denied"),
    "webhook_denied event",
  );
  await waitFor(
    () => service.queueStatus("/hooks/gh").active === 0,
    "refused run settled",
  );
  await service.stop();
});

Deno.test("WebhookService: concurrent runs each keep their own payload, trace context and vault scope", async () => {
  await withCapturedSpans(async () => {
    const scopes: ServeRunVaultScope[] = [];
    const outer = RunVaultAccess.create({ allowedVaults: ["leaked"] });
    const { service, runs } = await concurrentService({
      maxConcurrentRuns: 2,
      createVaultAccess: () => {
        const scope = { access: RunVaultAccess.create({}) };
        scopes.push(scope);
        return scope;
      },
    });
    const parents = [
      "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
      "00-1bf7651916cd43dd8448eb211c80319c-c7ad6b7169203331-01",
    ];
    await runWithVaultAccess(outer, async () => {
      for (const [i, route] of ["/hooks/gh", "/hooks/alerts"].entries()) {
        await withSpan(`POST ${route}`, {}, async () => {
          const request = await signedDeliveryTo(route, `{"n":${i}}`);
          request.headers.set("traceparent", parents[i]);
          await service.handleRequest(request);
        });
      }
    });
    await waitFor(() => runs.length === 2, "both runs in flight");

    assertEquals(runs.map((r) => r.input.traceparent), parents);
    assertEquals(runs.map((r) => r.input.webhook.body), [{ n: 0 }, { n: 1 }]);
    assertEquals(runs.map((r) => r.vaultAccess), scopes);
    assertEquals(runs.map((r) => r.ambient), [undefined, undefined]);
    assertEquals(runs.map((r) => r.span), [undefined, undefined]);
    for (const run of runs) run.release();
    await service.stop();
  });
});

Deno.test("WebhookService: a run started by a settling run does not inherit its scope", async () => {
  const outer = RunVaultAccess.create({ allowedVaults: ["leaked"] });
  const { service, runs } = await concurrentService({
    createVaultAccess: () => ({ access: outer }),
  });
  await service.handleRequest(await signedDeliveryTo("/hooks/gh", "{}"));
  await service.handleRequest(await signedDeliveryTo("/hooks/gh", "{}"));
  await waitFor(() => runs.length === 1, "first run started");
  runs[0].release();
  await waitFor(() => runs.length === 2, "second run started");
  assertEquals(runs[1].ambient, undefined);
  runs[1].release();
  await service.stop();
});

Deno.test("WebhookService.drain: waits for every in-flight run and leaves the queued one pending", async () => {
  const enqueued: string[] = [];
  const deleted: string[] = [];
  const { service, runs, completed } = await concurrentService({
    maxConcurrentRuns: 2,
    now: () => 1_000,
    runTracker: {
      enqueuePendingRun: (entry: { id: string }) => enqueued.push(entry.id),
      deletePendingRun: (id: string) => deleted.push(id),
    } as unknown as RunTrackerStore,
  });
  for (let i = 0; i < 3; i++) {
    await service.handleRequest(await signedDeliveryTo("/hooks/gh", "{}"));
  }
  await waitFor(() => runs.length === 2, "two runs in flight");

  let drained = false;
  const drain = service.drain(60_000).then(() => {
    drained = true;
  });
  runs[0].release();
  await waitFor(() => completed("run-1"), "first run completed");
  assertEquals(drained, false);
  runs[1].release();
  await drain;
  await service.stop();

  assertEquals(runs.length, 2);
  assertEquals(deleted, enqueued.slice(0, 2));
  assertEquals(service.queueStatus("/hooks/gh"), {
    active: 0,
    queued: 0,
    oldestQueuedAt: null,
    lastQueueDelayMs: 0,
  });
});

Deno.test("WebhookService.stop: aborts every in-flight run", async () => {
  const { service, runs } = await concurrentService({ maxConcurrentRuns: 3 });
  for (const route of ["/hooks/gh", "/hooks/gh", "/hooks/alerts"]) {
    await service.handleRequest(await signedDeliveryTo(route, "{}"));
  }
  await waitFor(() => runs.length === 3, "three runs in flight");
  await service.stop();

  assertEquals(runs.map((r) => r.signal.aborted), [true, true, true]);
  assertEquals(service.queueStatus("/hooks/gh").active, 0);
  assertEquals(service.queueStatus("/hooks/alerts").active, 0);
});

Deno.test("WebhookService.queueStatus: reports the oldest waiting delivery and the last start delay", async () => {
  let now = 1_000;
  const { service, runs } = await concurrentService({ now: () => now });
  await service.handleRequest(await signedDeliveryTo("/hooks/gh", "{}"));
  await waitFor(() => runs.length === 1, "first run started");
  now = 2_000;
  await service.handleRequest(await signedDeliveryTo("/hooks/gh", "{}"));

  assertEquals(service.queueStatus("/hooks/gh"), {
    active: 1,
    queued: 1,
    oldestQueuedAt: new Date(2_000).toISOString(),
    lastQueueDelayMs: 0,
  });
  assertEquals(service.queueStatus("/hooks/alerts"), {
    active: 0,
    queued: 0,
    oldestQueuedAt: null,
    lastQueueDelayMs: null,
  });

  now = 7_000;
  runs[0].release();
  await waitFor(() => runs.length === 2, "second run started");
  assertEquals(service.queueStatus("/hooks/gh").lastQueueDelayMs, 5_000);
  runs[1].release();
  await service.stop();
});

Deno.test("WebhookService.updateEndpoints: a removed route's queue delay is forgotten", async () => {
  const { service, runs, completed } = await concurrentService({
    now: () => 1_000,
  });
  await service.handleRequest(await signedDeliveryTo("/hooks/alerts", "{}"));
  await waitFor(() => runs.length === 1, "run started");
  runs[0].release();
  await waitFor(() => completed("run-1"), "run completed");
  assertEquals(service.queueStatus("/hooks/alerts").lastQueueDelayMs, 0);

  service.updateEndpoints([await parseWebhookFlag("/hooks/gh:deploy:secret")]);
  assertEquals(service.queueStatus("/hooks/alerts").lastQueueDelayMs, null);
  await service.stop();
});

Deno.test("WebhookService.updateEndpoints: a run of a route removed while it was queued records no delay", async () => {
  const { service, runs } = await concurrentService();
  await service.handleRequest(await signedDeliveryTo("/hooks/gh", "{}"));
  await waitFor(() => runs.length === 1, "first run started");
  await service.handleRequest(await signedDeliveryTo("/hooks/alerts", "{}"));

  service.updateEndpoints([await parseWebhookFlag("/hooks/gh:deploy:secret")]);
  runs[0].release();
  await waitFor(() => runs.length === 2, "queued run started");
  assertEquals(service.queueStatus("/hooks/alerts").lastQueueDelayMs, null);
  runs[1].release();
  await service.stop();
});

Deno.test("WebhookService: overlapping runs consume each pending entry exactly once", async () => {
  const enqueued: string[] = [];
  const deleted: string[] = [];
  const remoteDeletes: string[] = [];
  const { service, runs } = await concurrentService({
    maxConcurrentRuns: 3,
    runTracker: {
      enqueuePendingRun: (entry: { id: string }) => enqueued.push(entry.id),
      deletePendingRun: (id: string) => deleted.push(id),
    } as unknown as RunTrackerStore,
    controlPlaneStore: {
      put: () => Promise.resolve(),
      delete: (key: string) => {
        remoteDeletes.push(key);
        return Promise.resolve();
      },
    } as unknown as ControlPlaneStore,
  });
  for (const route of ["/hooks/gh", "/hooks/gh", "/hooks/alerts"]) {
    await service.handleRequest(await signedDeliveryTo(route, "{}"));
  }
  await waitFor(() => runs.length === 3, "three runs in flight");
  for (const run of runs) run.release();
  await service.stop();

  assertEquals(enqueued.length, 3);
  assertEquals([...deleted].sort(), [...enqueued].sort());
  assertEquals(
    [...remoteDeletes].sort(),
    enqueued.map((id) => `pending-runs/${id}`).sort(),
  );
});

Deno.test("WebhookService.cancelByRunId: cancels only the targeted run among concurrent ones", async () => {
  const { service, runs } = await concurrentService({ maxConcurrentRuns: 3 });
  for (const route of ["/hooks/gh", "/hooks/gh", "/hooks/alerts"]) {
    await service.handleRequest(await signedDeliveryTo(route, "{}"));
  }
  await waitFor(() => runs.length === 3, "three runs in flight");

  assertEquals(service.cancelByRunId("run-2", "superseded"), true);
  assertEquals(runs.map((r) => r.signal.aborted), [false, true, false]);
  assertEquals((runs[1].signal.reason as Error).message, "superseded");
  await waitFor(
    () => service.queueStatus("/hooks/gh").active === 1,
    "cancelled run settled",
  );

  assertEquals(service.cancelAllRuns("shutdown"), 2);
  assertEquals(runs.map((r) => r.signal.aborted), [true, true, true]);
  await service.stop();
});
