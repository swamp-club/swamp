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

export {
  type AuditCategory,
  type AuditDecision,
  type AuditEvent,
  type AuditOutcome,
  type AuditStage,
  type ChainedAuditEvent,
  createAuditEvent,
} from "./audit_event.ts";

export {
  type AuditEventInput,
  buildAuditEvent,
} from "./audit_event_builder.ts";

export { AuditEmitter, type AuditEmitterOptions } from "./audit_emitter.ts";

export {
  AuditChainState,
  CHAIN_SEED_DIGEST,
  verifyChain,
} from "./audit_chain.ts";

export {
  AuditWal,
  type AuditWalOptions,
  type WalCursorState,
} from "./audit_wal.ts";

export {
  type AuditEventTier,
  type AuditLevel,
  AuditPolicy,
  type AuditPolicyRule,
  classifyTier,
  DEFAULT_AUDIT_POLICY,
} from "./audit_policy.ts";

export {
  type AuditQueryFilters,
  type AuditQueryResult,
  AuditQueryService,
  type AuditVerifyResult,
} from "./audit_query_service.ts";

export type { AuditSink } from "./audit_sink.ts";

export {
  applyHmac,
  generateHmacKeyBytes,
  type HmacContext,
  hmacField,
  type HmacKeyProvider,
  HmacKeyRegistry,
  type HmacKeyVersion,
  importHmacKey,
} from "./audit_hmac.ts";

export type { AuditStore } from "./audit_store.ts";

export {
  matchesSinkFilter,
  parseSinkFilter,
  type SinkFilterConfig,
} from "./sink_filter.ts";

export { RingBuffer } from "./ring_buffer.ts";

export {
  type AlertAction,
  type AlertFiredEvent,
  type AlertRuleConfig,
  AlertRuleEngine,
  type AlertRuleMatch,
  type AlertRuleState,
  type AlertRuleStatus,
  type AlertThreshold,
} from "./audit_alerts.ts";

export {
  type AuditSinkFactory,
  type AuditSinkTypeInfo,
  AuditSinkTypeRegistry,
} from "./audit_sink_type_registry.ts";

export { AuditSinkHotReloader } from "./audit_sink_hot_reloader.ts";

export {
  COMPLIANCE_REPORTS,
  type ComplianceReportDefinition,
  type ComplianceReportResult,
  getComplianceReport,
} from "./audit_compliance_reports.ts";
