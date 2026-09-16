# Webhook Extensions

Custom authentication, payload shaping, and responses for `swamp serve` webhook
endpoints. Use one when a provider is not covered by the built-in schemes
(`github`, `jira`, `linear`, `stripe`, `slack`, `generic`) — e.g. a static
secret token header.

Source: `src/domain/webhooks/webhook_handler.ts`, `src/serve/webhook.ts`
(`handleRequest`).

## Contents

- [Export](#export)
- [Handler contract](#handler-contract)
- [Request order and failure handling](#request-order-and-failure-handling)
- [Example: static token with a challenge echo](#example-static-token-with-a-challenge-echo)
- [Configure an endpoint](#configure-an-endpoint)
- [Testing](#testing)

## Export

```typescript
// extensions/webhooks/my_hook.ts
import { z } from "npm:zod@4";

export const webhook = {
  type: "@myorg/my-hook", // lowercase @collective/name — also the scheme name
  name: "My Hook",
  description: "Verifies My Provider webhooks",
  configSchema: z.object({ header: z.string().default("x-my-token") }), // optional
  createHandler: (config: Record<string, unknown>) => ({/* WebhookHandler */}),
};
```

Manifest: `webhooks: [my_hook.ts]`. Bundles land in `.swamp/webhook-bundles/`.

## Handler contract

```typescript
interface WebhookHandler {
  readonly signatureHeader: string; // lowercase; never exposed to workflows
  readonly requiredHeaders: readonly string[]; // lowercase; checked before body read
  verify(body: Uint8Array, headers: Headers, secret: string):
    | Promise<boolean>
    | boolean;
  transform?(body: unknown, headers: Record<string, string>): unknown; // may be async
  respond?(payload: WebhookPayload): WebhookResponse | undefined; // may be async
}

interface WebhookResponse {
  status: number; // 200–599
  headers?: Record<string, string>;
  body?: unknown; // strings sent as-is, other values as JSON
  enqueue: boolean; // false = reply without starting a run
}
```

- `verify` must return exactly `true` to accept. Compare secrets in constant
  time (e.g. compare SHA-256 digests of both values) — never `===` on the raw
  secret.
- `transform` replaces `webhook.body` for the workflow. It receives the parsed
  body and the **redacted** headers only; the result must be JSON-serializable.
- `respond` receives the final payload. Return `undefined` for the default
  `200 {"status":"queued"}`.

## Request order and failure handling

Core runs: route match → `requiredHeaders` (401) → 10 MB body limit (413) →
`verify` (false/throw → uniform 401) → header redaction → `transform` →
`respond` → queue backpressure (503) → run enqueued.

- Hooks never run for unauthenticated requests.
- A throwing `transform`/`respond`, a non-serializable body, an invalid status,
  or a type that is no longer loaded returns a generic `500`; no run is queued.
- Hooks run inline with **no timeout** — keep them fast and non-blocking.
- Core does not filter `respond` headers, and only redacts `signatureHeader`
  plus known credential headers (names ending `-token`/`-secret`, etc.). Put any
  other secret-bearing header in `signatureHeader`.
- A static token is weaker than an HMAC (no body integrity, replayable); only
  use it over TLS.

## Example: static token with a challenge echo

```typescript
// extensions/webhooks/static_token.ts
async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length && i < b.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const HEADER = "x-my-provider-token";

export const webhook = {
  type: "@myorg/static-token",
  name: "Static token",
  description: "Accepts requests whose token header equals the secret",
  createHandler: () => ({
    signatureHeader: HEADER,
    requiredHeaders: [HEADER],
    verify: async (_body: Uint8Array, headers: Headers, secret: string) =>
      equal(await digest(headers.get(HEADER) ?? ""), await digest(secret)),
    respond: (payload: { body: unknown }) => {
      const body = payload.body as { challenge?: string };
      return body?.challenge
        ? { status: 200, body: body.challenge, enqueue: false }
        : undefined;
    },
  }),
};
```

## Configure an endpoint

```yaml
# .swamp/serve.yaml
webhooks:
  - route: /hooks/my-provider
    workflow: handle-event
    secret: "@env=MY_PROVIDER_TOKEN"
    scheme: "@myorg/static-token"
    config: {} # optional, validated against configSchema at startup
```

CLI equivalent (no `config`):
`swamp serve --webhook '/hooks/my-provider:handle-event:@env=MY_PROVIDER_TOKEN:@myorg/static-token'`.
Serve fails at startup if the type is not installed (trusted collectives are
auto-pulled) or the config is invalid.

## Testing

```typescript
import { assertWebhookExportConformance } from "@swamp-club/swamp-testing";
import { webhook } from "./static_token.ts";

Deno.test("webhook export conforms", async () => {
  await assertWebhookExportConformance(webhook, {
    validRequest: {
      body: "{}",
      headers: { "x-my-provider-token": "s" },
      secret: "s",
    },
    invalidRequests: [
      { body: "{}", headers: { "x-my-provider-token": "x" }, secret: "s" },
      { body: "{}", headers: {}, secret: "s" },
    ],
  });
});
```

Test `transform`/`respond` directly by calling the handler returned from
`webhook.createHandler({})`.
