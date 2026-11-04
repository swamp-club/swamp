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

import { resolve } from "@std/path";
import { UserError } from "../domain/errors.ts";
import { resolveAuditStoreRetentionDays } from "../domain/audit/audit_service.ts";
import { AuditEmitter } from "../domain/serve_audit/audit_emitter.ts";
import type { AuditCategory } from "../domain/serve_audit/audit_event.ts";
import {
  type AuditLevel,
  AuditPolicy,
  type AuditPolicyRule,
} from "../domain/serve_audit/audit_policy.ts";
import { AuditWal } from "../domain/serve_audit/audit_wal.ts";
import { FileSystemControlPlaneStore } from "../infrastructure/persistence/fs_control_plane_store.ts";
import { RemoteAuditStore } from "../infrastructure/persistence/remote_audit_store.ts";
import { swampPath } from "../infrastructure/persistence/paths.ts";
import { recoverAuditChainState } from "./audit_chain_recovery.ts";
import { StoreSink } from "./audit_sinks/store_sink.ts";
import { WalSink } from "./audit_sinks/wal_sink.ts";
import {
  type ConnectionContext,
  emitSystemAuditEvent,
} from "./handlers/shared.ts";
import { parseAuditConfig, type ServeConfigFile } from "./serve_config.ts";

/**
 * Compose the existing local durable audit pipeline for the stdio engine.
 * Returns an idempotent shutdown that drains writes and preserves its chain.
 */
export async function initializeLocalEngineAudit(
  ctx: ConnectionContext,
  config: ServeConfigFile | null,
  repoAuditRetentionMs?: number,
): Promise<() => Promise<void>> {
  const audit = parseAuditConfig(config);
  if (!audit) return () => Promise.resolve();
  if (
    audit.stores.some((entry) =>
      entry.type !== undefined || entry.config !== undefined
    ) || audit.sinks.length > 0 || audit.hmacEnabled || audit.alerts.length > 0
  ) {
    throw new UserError(
      "The local-v1 engine supports local audit stores without external sinks, HMAC or alerts.",
      "unsupported_profile",
    );
  }
  const control = new FileSystemControlPlaneStore(swampPath(ctx.repoDir));
  const stores = audit.stores.map((entry) =>
    new RemoteAuditStore(control, `_audit/${entry.target}/`)
  );
  const wal = new AuditWal({
    dir: resolve(ctx.repoDir, audit.walDir),
    maxWalBytes: audit.walMaxBytes,
  });
  await wal.initialize();
  // Recovery precedes the timer-owning sinks. AuditWal uses awaited per-call
  // filesystem operations and holds no descriptor or timer to close on failure.
  const chainState = await recoverAuditChainState(wal, stores[0]);
  const downstream = new StoreSink({
    stores: stores.map((store, i) => ({
      store,
      retentionDays: resolveAuditStoreRetentionDays(
        audit.stores[i].retention?.days,
        repoAuditRetentionMs,
      ),
    })),
    batchSize: audit.batchSize,
    flushIntervalMs: audit.flushIntervalMs,
  });
  const sink = new WalSink({
    wal,
    downstream,
    checkpointIntervalMs: audit.flushIntervalMs,
  });
  try {
    await sink.replay();
  } catch (error) {
    await sink.close();
    throw error;
  }
  const policy = new AuditPolicy(
    audit.policyRules.map((rule) => ({
      category: rule.category as AuditCategory | undefined,
      action: rule.action,
      tier: rule.tier as AuditPolicyRule["tier"],
      level: rule.level as AuditLevel,
    })),
    audit.policyDefaultLevel as AuditLevel,
  );
  const emitter = new AuditEmitter({ sinks: [sink], policy, chainState });
  ctx.auditEmitter = emitter;
  ctx.auditStores = stores;
  ctx.auditWal = wal;
  ctx.auditPolicy = policy;
  ctx.auditFailOpen = audit.failOpen;
  emitSystemAuditEvent(ctx, "instance.start");
  let closing: Promise<void> | undefined;
  return () => {
    closing ??= (async () => {
      emitSystemAuditEvent(ctx, "instance.stop");
      await emitter.flush();
      await emitter.close();
      await wal.saveChainState(emitter.chainState.snapshot());
    })();
    return closing;
  };
}
