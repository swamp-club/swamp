---
audience: everyone
last-verified: 2026-09-08 @ HEAD
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
   absorbed; audit never disrupts requests unless fail-secure mode is on.
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

- `audit.query`: paginated query filtered by time range, principal, category,
  action, resource and outcome. Needs `read` permission on the `audit` resource
  kind.
- `audit.verify`: checks chain integrity for a time range and reports broken
  chains or missing events.

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
- `auth.session.terminated`: the server closed a WebSocket session because the
  token it was opened with lost its authority. `detail` is the cause:
  `revoked`, `rotated`, `expired`, `deleted` or `invalid` (the record no longer
  parses). `initiatedBy` is the admin who revoked or rotated the token, or
  `system` when the periodic revalidation found it. `sourceIp` is the closed
  session's address. One event is written per closed session, before its
  socket closes

`DeviceAuthDeps` carries the `AuditEmitter` and `instanceId`. The serve HTTP
handler resolves `sourceIp` (honouring `trustProxy` / `X-Forwarded-For`) and
passes it on. With no `auditEmitter`, the emit helper does nothing.

The `access.token.revoke` WebSocket handler audits token revocation under the
`admin` category.

Successful `auth.token.used` events hold the token name, principal, source IP
and ingress metadata, never the secret. They are best-effort and cannot
interrupt authentication. Token-creation events use the new token's name as the
resource name.

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
