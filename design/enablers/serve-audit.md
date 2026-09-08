---
audience: everyone
last-verified: 2026-09-08 @ HEAD
---

# Serve Audit

Audit event pipeline for `swamp serve`. Captures authorization decisions across
all handlers and success/failure events for every operation. Events are
chain-hashed for tamper evidence, persisted durably via a write-ahead log, and
queryable through the `audit.query` API and `swamp audit log` CLI command.

This is distinct from the CLI audit subsystem (`src/domain/audit/`), which
tracks local command history. The serve audit bounded context
(`src/domain/serve_audit/`) concerns server-side request-level events across
authenticated WebSocket connections.

## How it works

```
Handler → authorizeOrReject / audited() → AuditEmitter → RingBuffer → [chain hash] → WalSink/StoreSink → AuditStore(s)
```

1. **authorizeOrReject** returns `{ allowed, decision }` — the `AccessDecision`
   is captured in the audit event so every allow/deny is traceable to a specific
   grant rule. Denials emit an audit event as a side effect.
2. **audited()** wraps a handler's `Promise<void>`, emitting success on
   resolution and failure on rejection. It re-throws the original error so
   handler semantics are unchanged. All 106+ handlers are wrapped.
3. **AuditEmitter** appends events synchronously to a **RingBuffer** (10,000
   capacity). During drain, events receive chain-hashed integrity fields
   (sequence, SHA-256 digest, version) via **AuditChainState** before reaching
   sinks. Sink errors are logged and absorbed — audit never disrupts request
   handling unless fail-secure mode is enabled.
4. **AuditPolicy** evaluates each event against ordered rules to determine the
   detail level (none, metadata, request, requestResponse). Management-tier
   events (audit.query, audit.verify) default to metadata level.
5. **WalSink** spills events to local disk when the remote backend is
   unreachable, replays on reconnection. Configurable max size (default 100MB).
6. **StoreSink** batches events in memory, writes date-partitioned JSONL
   (`events/YYYY-MM-DD/<uuid>.jsonl`) to all configured **AuditStore** targets
   on a timer or when the batch is full. Supports per-target retention with
   automatic date-partition GC.
7. **RemoteAuditStore** adapts `ControlPlaneStore` with a key prefix.

## Configuration

Audit is enabled via `serve.yaml`. No config means zero behavior change.

Each audit store target can reference a **dedicated datastore** — a separate
S3 bucket, a separate provider, fully independent from the repo's main
datastore. This is the recommended setup: audit data should not live alongside
application data, so it cannot be tampered with by someone who has access to
the main datastore.

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

Config values support `${{ }}` expression interpolation — the same syntax as
datastore config in `.swamp.yaml` (see
[datastores.md § Config Value Interpolation](datastores.md#config-value-interpolation)).

A store entry without `type` + `config` falls back to the repo's existing
control-plane store (shared datastore). This works for development but logs
a warning at startup — production deployments should use a dedicated store.

## What is audited

- **All handlers**: authorization decision capture via `authorizeOrReject` and
  success/failure auditing via `audited()` wrapper
- **Chain hashing**: every event carries a sequence number and SHA-256 digest
  chaining it to the previous event for tamper evidence
- **Access decisions**: every allow/deny is recorded with the matched grant
  rule, effect, and principal groups at decision time

## Query API

- `audit.query` — paginated query with filters (time range, principal,
  category, action, resource, outcome). Requires `read` permission on the
  `audit` resource kind.
- `audit.verify` — verify chain integrity for a time range, reports broken
  chains or missing events

## CLI commands

- `swamp audit log` — query the audit log with filters (`--since`, `--until`,
  `--principal`, `--category`, `--action`, `--outcome`, `--limit`)
- `swamp audit verify` — check chain integrity for a time range
- `swamp audit log --follow` — stream new audit events in real-time after the
  initial query (Ctrl+C to stop)

## Real-time streaming

`audit.subscribe` starts a live stream of audit events over the existing
WebSocket connection. The server sends `audit.event` messages as they occur,
filtered by the subscription parameters. Subscriptions stay active until the
connection closes or the client sends `audit.unsubscribe`.

Filter shape matches `audit.query`: categories, principals, actions, outcomes,
resourceKind. Per-connection subscription cap: 2. Subscriptions are
re-authorized every 60 seconds — revoked grants terminate the stream.

No durability guarantee — this is live streaming, not a replay mechanism. Missed
events are queryable via `audit.query`.

## System events

The `system` audit category captures infrastructure lifecycle events with
`principalKind: "system"`:

- `instance.start` — emitted when the serve instance starts (with version)
- `instance.stop` — emitted on graceful shutdown

System events are always at `metadata` audit level (management tier).

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

## Future phases

- **Phase 4**: Webhook and syslog sinks, bulk export, HMAC, HA join/leave
  system events, health state transition events
- **Phase 5**: Extension sinks, alerting, compliance templates
