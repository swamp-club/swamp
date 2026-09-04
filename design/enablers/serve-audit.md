---
audience: everyone
last-verified: 2026-09-04 @ HEAD
---

# Serve Audit

Audit event pipeline for `swamp serve`. Automatically captures authorization
denials across all handlers and success/failure events for high-value operations
(execution, secrets, admin, access). Events persist to remote stores as
date-partitioned JSONL.

This is distinct from the CLI audit subsystem (`src/domain/audit/`), which
tracks local command history. The serve audit bounded context
(`src/domain/serve_audit/`) concerns server-side request-level events across
authenticated WebSocket connections.

## How it works

```
Handler → authorizeOrReject / audited() → AuditEmitter → RingBuffer → StoreSink → AuditStore(s)
```

1. **authorizeOrReject** emits a denial event as a side effect when access is
   denied (optional `AuditEmitter` parameter — existing callers are unaffected).
2. **audited()** wraps a handler's `Promise<void>`, emitting success on
   resolution and failure on rejection. It re-throws the original error so
   handler semantics are unchanged.
3. **AuditEmitter** appends events synchronously to a **RingBuffer** (10,000
   capacity), then drains asynchronously to registered sinks. Sink errors are
   logged and absorbed — audit never disrupts request handling.
4. **StoreSink** batches events in memory, writes date-partitioned JSONL
   (`events/YYYY-MM-DD/<uuid>.jsonl`) to all configured **AuditStore** targets
   on a timer or when the batch is full. Flushes on shutdown via `AbortSignal`.
5. **RemoteAuditStore** adapts `ControlPlaneStore` with an `_audit/` key prefix.

## Configuration

Audit is enabled via `serve.yaml`. No config means zero behavior change.

```yaml
audit:
  stores:
    - target: default
  batch-size: 100
  flush-interval: 5s
```

## What is audited

- **All 106 handlers**: automatic denial auditing via `authorizeOrReject`
- **~20 high-value handlers**: success/failure via `audited()` wrapper
  - Execution: `workflow.run`, `model.method.run`
  - Secrets: `vault.get`, `vault.put`, `vault.delete`
  - Access: `access.check`, `access.can-i`, `access.grant.list`,
    `access.group.list`, `access.group.list-idp`, `access.reload`
  - Admin: `serve.reload`, `model.create`, `model.delete`, `model.edit`,
    `workflow.create`, `workflow.delete`, `workflow.edit`, `data.delete`

## Domain model

| Type              | DDD Building Block | Location                          |
| ----------------- | ------------------ | --------------------------------- |
| AuditEvent        | Entity             | `src/domain/serve_audit/`         |
| AuditCategory     | Value Object       | `src/domain/serve_audit/`         |
| AuditStage        | Value Object       | `src/domain/serve_audit/`         |
| AuditOutcome      | Value Object       | `src/domain/serve_audit/`         |
| RingBuffer        | Data Structure     | `src/domain/serve_audit/`         |
| AuditEmitter      | Domain Service     | `src/domain/serve_audit/`         |
| AuditSink         | Port Interface     | `src/domain/serve_audit/`         |
| AuditStore        | Port Interface     | `src/domain/serve_audit/`         |
| AuditEventBuilder | Factory            | `src/domain/serve_audit/`         |
| RemoteAuditStore  | Adapter            | `src/infrastructure/persistence/` |
| StoreSink         | Adapter            | `src/serve/audit_sinks/`          |

## Future phases

- **Phase 2**: Write-ahead log, chain hashing, query API, complete handler
  coverage
- **Phase 3**: Real-time WebSocket streaming
- **Phase 4**: Webhook and syslog sinks, bulk export
- **Phase 5**: Extension sinks, alerting
