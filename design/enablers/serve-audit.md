---
audience: everyone
last-verified: 2026-10-05 @ HEAD
---

# Serve Audit

The audit event pipeline for `swamp serve`. It records every handler's
authorization decisions and a success or failure event per operation. Events are
chain-hashed to show tampering, kept durable by a write-ahead log, and queried
with the `audit.query` API and `swamp audit log`.

The CLI audit subsystem (`src/domain/audit/`) is separate: it tracks local
command history. This bounded context (`src/domain/serve_audit/`) covers
server-side events on authenticated WebSocket connections.

## How it works

```
Handler → authorizeOrReject / audited() → AuditEmitter → RingBuffer → [chain hash] → WalSink/StoreSink → AuditStore(s)
```

1. **authorizeOrReject** returns `{ allowed, decision }`. The event keeps the
   `AccessDecision`, so every allow or deny traces to a grant rule. Denials also
   emit an event.
2. **audited()** wraps a handler's `Promise<void>`, emitting success on resolve
   and failure on reject. It re-throws the original error, so handler behavior
   is unchanged. All 106+ handlers are wrapped.
3. **AuditEmitter** appends events synchronously to a **RingBuffer** (capacity
   10,000). On drain, **AuditChainState** adds integrity fields (sequence,
   SHA-256 digest, version) before sinks see them. Sink errors are logged and
   absorbed; audit never disrupts requests unless fail-secure mode is on. See
   [Delivery to sinks](#delivery-to-sinks).
4. **AuditPolicy** matches ordered rules to pick each event's detail level:
   none, metadata, request or requestResponse. Management-tier events
   (audit.query, audit.verify) default to metadata.
5. **WalSink** spills events to local disk while the remote backend is down and
   replays them on reconnect. Max size is configurable (default 100MB).
6. **StoreSink** batches events and, on a timer or a full batch, writes
   date-partitioned JSONL (`events/YYYY-MM-DD/<uuid>.jsonl`) to every
   configured **AuditStore** target. Each target can set its own retention; old
   date partitions are deleted automatically.
7. **RemoteAuditStore** adapts `ControlPlaneStore` with a key prefix.

## Delivery to sinks

A sink declares itself `durable` (WalSink, StoreSink) or not (WebSocket,
webhook, syslog). The emitter keeps the durable path independent of every
other sink:

- **Chained once.** Each event gets its HMAC, sequence and digest, and is
  checked against the alert rules, exactly once. The chained form is kept by
  buffer sequence until every sink has it, so a sink that is retried receives
  the same sequence and digest the store recorded.
- **Durable first.** A drain writes the durable sinks in order and waits for
  them. Non-durable sinks deliver on their own and never hold a drain. A failed
  durable write is retried on the next event, on flush, and after a fixed 1s;
  it is never backed off. If durable writes fail for so long that events leave
  the buffer, `swamp audit verify` reports the gap as a broken chain.
- **One sink's lag is its own.** Each sink has its own cursor. A sink more than
  the buffer's capacity behind is moved up to the oldest event still held; the
  events it missed are counted and logged against that sink only.
- **One write at a time.** A non-durable sink has at most one `write` in
  flight. A write that outlives the 30s timeout counts as a failure, but the
  sink is not written to again until that call settles.
- **Backoff.** A failed non-durable write is retried after 1s, doubling per
  failure up to 60s, and reset on success or when hot-reload replaces the
  sink. `flush` and `close` respect it, so events still pending for a sink
  that is backing off at shutdown are not delivered to that sink.

## Configuration

Audit is turned on in `serve.yaml`. With no config, nothing changes.

Each store target can use a **dedicated datastore**: its own S3 bucket or
provider, independent of the repo's main datastore. This is recommended, so that
someone with access to the main datastore cannot alter audit data.

```yaml
audit:
  stores:
    - target: security-audit
      type: "@swamp/s3-datastore"
      config:
        bucket: my-audit-bucket
        region: us-east-1
      retention:
        days: 90
  batch-size: 100
  flush-interval: 5s
  fail-open: true
  policy:
    default-level: metadata
    rules:
      - category: secrets
        level: requestResponse
      - tier: management
        level: metadata
  wal:
    directory: .swamp/audit-wal
    max-size: 100MB
```

Config values support `${{ }}` interpolation, the same syntax as datastore
config in `.swamp.yaml` (see
[datastores.md § Config Value Interpolation](datastores.md#config-value-interpolation)).

A store entry without `type` + `config` uses the repo's existing control-plane
store (the shared datastore). That works for development but logs a startup
warning; production should use a dedicated store.

## What is audited

- **All handlers**: the authorization decision via `authorizeOrReject`, and
  success or failure via the `audited()` wrapper.
- **Chain hashing**: every event has a sequence number and a SHA-256 digest
  that links it to the previous event.
- **Access decisions**: every allow or deny, with the matched grant rule, its
  effect, and the principal's groups at decision time.

## Query API

Every `audit.*` request needs `admin` on `access:audit`, except
`audit.unsubscribe`, which only ends the caller's own stream.

- `audit.query`: paginated query filtered by time range, principal, category,
  action, resource and outcome.
- `audit.verify`: checks chain integrity for a time range and reports broken
  chains or missing events.
- `audit.timeline`: the agent command audit behind `swamp audit --server` (see
  `design/surfaces/audit.md`).

## CLI commands

- `swamp audit log`: query the audit log with `--since`, `--until`,
  `--principal`, `--category`, `--action`, `--outcome`, `--limit`.
- `swamp audit verify`: check chain integrity for a time range.
- `swamp audit log --follow`: after the initial query, stream new events live
  until Ctrl+C.

## Real-time streaming

`audit.subscribe` streams audit events live on the existing WebSocket. The
server sends matching `audit.event` messages until the connection closes or the
client sends `audit.unsubscribe`.

Filters match `audit.query`: categories, principals, actions, outcomes,
resourceKind. Each connection can hold at most 2 subscriptions. They are
re-authorized every 60 seconds, and a revoked grant ends the stream.

There is no durability guarantee and no replay. Use `audit.query` for missed
events.

## Auth events

The `auth` audit category records OAuth device flow operations. Other categories
go through the `audited()` wrapper on WebSocket handlers; these do not. The HTTP
device auth handler emits them inline (`src/serve/device_auth_handler.ts`) via
`buildAuditEvent` + `emitter.emit`. The device flow runs on the HTTP path before
authentication, so there is no WebSocket or principal yet.

Actions:

- `auth.login.started`: device grant started (anonymous principal)
- `auth.login.completed`: OAuth flow completed and a server token minted
  (success)
- `auth.login.denied`: admission failed or the user denied authorization
- `auth.login.expired`: the device code expired before completion
- `auth.token.used`: a server token passed direct authentication
- `auth.session.terminated`: the server closed a WebSocket session or SSE
  health stream because the token it was opened with lost its authority.
  `detail` is the cause: `revoked`, `rotated`, `expired`, `deleted` or
  `invalid` (the record no longer parses). `initiatedBy` is the admin who
  revoked or rotated the token, or `system` when the periodic revalidation
  found it. `sourceIp` is the closed session's address. One event is written
  per session closed this way, before it closes; deprovisioning closes a
  principal's sessions and streams without one

`DeviceAuthDeps` carries the `AuditEmitter` and `instanceId`. The serve HTTP
handler resolves `sourceIp` (honouring `trustProxy` / `X-Forwarded-For`) and
passes it on. With no `auditEmitter`, the emit helper does nothing.

The `access.token.revoke` WebSocket handler audits token revocation under the
`admin` category.

Successful `auth.token.used` events hold the token name, principal, source IP
and ingress metadata, never the secret. They are best-effort and cannot
interrupt authentication. Like other events, they record the token's principal
as its kind in `principalKind` and its bare id in `principalId` (a worker token
`worker:build-1` is `principalKind: "worker"`, `principalId: "build-1"`), with
the full principal in `initiatedBy`. Query filters (`swamp audit log` and
`swamp audit export --principal`), alert `match.principal` rules and compliance
report grouping therefore match these events on the bare id, as they do every
other event. Events written before swamp-club#2705 hold `principalKind: "user"`
and the kind-prefixed principal in `principalId` for every token; the audit log
is append-only and hash-chained, so they keep that shape. Token-creation events
use the new token's name as the resource name.

## Trigger events

Scheduled and webhook runs act as built-in service principals
(`principalKind: "service"`, `initiatedBy` `service:scheduler` or
`service:webhook`; see [access-control](access-control.md)). They are audited
in the `execution` category, alongside API `workflow.run` events, with the
workflow as the resource:

- `workflow.schedule.fire`: a scheduled run started. Detail carries `run`,
  `fireTime`, and `replayed=true` for a fire replayed at boot. Source IP is
  `127.0.0.1`.
- `workflow.schedule.skipped`: a fire did not run. `reason=overlap` (previous run
  still in progress; outcome `failure`) or `reason=dedup` (another instance
  claimed the fire; outcome `success`). A fleet audit shows one fire plus a
  dedup skip from each other instance per tick.
- `workflow.webhook.fire`: a webhook run started. Detail carries `route` and
  `run`; source IP is the sender's (`X-Forwarded-For` when `--trust-proxy`).
- `workflow.webhook.rejected`: a delivery was refused before it queued (missing
  header, invalid signature, oversized body, queue full, shutting down, handler
  failure). Outcome `failure`; detail carries `route` and `reason`. Because
  this traffic is unauthenticated, rejections are coalesced per route and reason:
  one event per 60 s window, with `suppressed=<n>` counting those dropped since
  the previous event (`src/serve/webhook_audit_coalescer.ts`).

A run refused by authorization is an `access` denial (`action: run`, outcome
`denied`, with the decision), like a refused WebSocket request. Audit writes for
triggers never throw into a run or a webhook response. Serve emits them in both
log and `--json` output modes.

Audit queries, alert matches and compliance reports key on `principalId` alone,
so `service:scheduler` and a user named `scheduler` share a bucket there;
filter on `principalKind` to tell them apart.

## System events

The `system` audit category records infrastructure lifecycle events with
`principalKind: "system"`:

- `instance.start`: the serve instance started (with version)
- `instance.stop`: graceful shutdown
- `instance.join`: a new peer instance appeared in the cluster
- `instance.leave`: a peer instance left the cluster
- `health.transition`: instance health changed (healthy/degraded/unhealthy)

System events are always at `metadata` level (management tier).

## Domain model

| Type                    | DDD Building Block | Location                          |
| ----------------------- | ------------------ | --------------------------------- |
| AuditEvent              | Entity             | `src/domain/serve_audit/`         |
| ChainedAuditEvent       | Type Alias         | `src/domain/serve_audit/`         |
| AuditDecision           | Value Object       | `src/domain/serve_audit/`         |
| AuditCategory           | Value Object       | `src/domain/serve_audit/`         |
| AuditStage              | Value Object       | `src/domain/serve_audit/`         |
| AuditOutcome            | Value Object       | `src/domain/serve_audit/`         |
| AuditLevel              | Value Object       | `src/domain/serve_audit/`         |
| AuditPolicyRule         | Value Object       | `src/domain/serve_audit/`         |
| AuditSubscriptionFilter | Value Object       | `src/serve/audit_sinks/`          |
| AuditChainState         | Domain Service     | `src/domain/serve_audit/`         |
| RingBuffer              | Data Structure     | `src/domain/serve_audit/`         |
| AuditEmitter            | Domain Service     | `src/domain/serve_audit/`         |
| AuditPolicy             | Value Object       | `src/domain/serve_audit/`         |
| AuditWal                | Domain Service     | `src/domain/serve_audit/`         |
| AuditQueryService       | Domain Service     | `src/domain/serve_audit/`         |
| AuditSink               | Port Interface     | `src/domain/serve_audit/`         |
| AuditStore              | Port Interface     | `src/domain/serve_audit/`         |
| AuditEventBuilder       | Factory            | `src/domain/serve_audit/`         |
| RemoteAuditStore        | Adapter            | `src/infrastructure/persistence/` |
| StoreSink               | Adapter            | `src/serve/audit_sinks/`          |
| WalSink                 | Adapter            | `src/serve/audit_sinks/`          |
| WebSocketSink           | Adapter            | `src/serve/audit_sinks/`          |
| WebhookSink             | Adapter            | `src/serve/audit_sinks/`          |
| SyslogSink              | Adapter            | `src/serve/audit_sinks/`          |
| CefFormatter            | Domain Service     | `src/serve/audit_sinks/`          |
| AuditHmac               | Domain Service     | `src/domain/serve_audit/`         |
| SinkFilterConfig        | Value Object       | `src/domain/serve_audit/`         |
| HmacContext             | Value Object       | `src/domain/serve_audit/`         |

## Phase 5 (completed)

Alert rules, compliance reports, HMAC key rotation, streaming bulk export, and
hot-reload of external sinks.

| Concept                 | DDD Building Block | Location                          |
| ----------------------- | ------------------ | --------------------------------- |
| HmacKeyRegistry         | Aggregate          | `src/domain/serve_audit/`         |
| HmacKeyVersion          | Value Object       | `src/domain/serve_audit/`         |
| AlertRuleEngine         | Aggregate          | `src/domain/serve_audit/`         |
| AlertRule               | Entity             | `src/domain/serve_audit/`         |
| AlertRuleMatch          | Value Object       | `src/domain/serve_audit/`         |
| AlertThreshold          | Value Object       | `src/domain/serve_audit/`         |
| AlertAction             | Value Object       | `src/domain/serve_audit/`         |
| AuditSinkHotReloader    | Domain Service     | `src/domain/serve_audit/`         |

## Future phases

- **Phase 6**: Extension sink API. Extension authors could register custom audit
  sinks (Kafka, Elasticsearch, etc.) through the AuditSink interface. This needs
  design work on the trust model, discovery and packaging, sandbox, and
  lifecycle.
