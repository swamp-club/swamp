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

import type { AlertRuleConfig } from "../domain/serve_audit/audit_alerts.ts";
import type { AuditCategory } from "../domain/serve_audit/audit_event.ts";
import {
  type AuditLevel,
  AuditPolicy,
  type AuditPolicyRule,
} from "../domain/serve_audit/audit_policy.ts";
import type { AuditConfig } from "./serve_config.ts";

const AUDIT_ON_OFF =
  "restart serve to turn audit on or off; the audit chain is opened at startup";
const AUDIT_CHAIN =
  "restart serve to change it; the audit chain and WAL are opened at startup";

export interface AuditConfigChanges {
  /** policy, alerts, fail-open and sinks: reload applies these */
  readonly applied: readonly AuditAppliedSetting[];
  readonly needsRestart: readonly { setting: string; reason: string }[];
}

export type AuditAppliedSetting =
  | "audit.policy"
  | "audit.alerts"
  | "audit.fail-open"
  | "audit.sinks";

function differs(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

/**
 * What a serve.yaml edit changed in the audit block. Stores, WAL, HMAC and
 * batching hold the hash chain, so only a restart changes them.
 */
export function diffAuditConfig(
  before: AuditConfig | null,
  after: AuditConfig | null,
): AuditConfigChanges {
  if (before === null && after === null) {
    return { applied: [], needsRestart: [] };
  }
  if (before === null || after === null) {
    return {
      applied: [],
      needsRestart: [{ setting: "audit", reason: AUDIT_ON_OFF }],
    };
  }
  const applied: AuditAppliedSetting[] = [];
  if (
    differs(before.policyDefaultLevel, after.policyDefaultLevel) ||
    differs(before.policyRules, after.policyRules)
  ) {
    applied.push("audit.policy");
  }
  if (differs(before.alerts, after.alerts)) applied.push("audit.alerts");
  if (before.failOpen !== after.failOpen) applied.push("audit.fail-open");
  if (differs(before.sinks, after.sinks)) applied.push("audit.sinks");

  const needsRestart: { setting: string; reason: string }[] = [];
  const restartOnly: [string, boolean][] = [
    ["audit.stores", differs(before.stores, after.stores)],
    [
      "audit.wal",
      before.walDir !== after.walDir ||
      before.walMaxBytes !== after.walMaxBytes,
    ],
    [
      "audit.hmac",
      before.hmacEnabled !== after.hmacEnabled ||
      before.hmacVault !== after.hmacVault || before.hmacKey !== after.hmacKey,
    ],
    ["audit.batch-size", before.batchSize !== after.batchSize],
    ["audit.flush-interval", before.flushIntervalMs !== after.flushIntervalMs],
  ];
  for (const [setting, changed] of restartOnly) {
    if (changed) needsRestart.push({ setting, reason: AUDIT_CHAIN });
  }
  return { applied, needsRestart };
}

/** the policy startup and reload both build from the audit block */
export function auditPolicyFrom(config: AuditConfig): AuditPolicy {
  return new AuditPolicy(
    config.policyRules.map((rule): AuditPolicyRule => ({
      category: rule.category as AuditCategory | undefined,
      action: rule.action,
      tier: rule.tier as AuditPolicyRule["tier"],
      level: rule.level as AuditLevel,
    })),
    config.policyDefaultLevel as AuditLevel,
  );
}

/** the alert rules startup and reload both build from the audit block */
export function alertRulesFrom(config: AuditConfig): AlertRuleConfig[] {
  return config.alerts.map((alert) => ({
    name: alert.name,
    description: alert.description,
    match: {
      category: alert.match.category,
      action: alert.match.action,
      outcome: alert.match.outcome,
      principal: alert.match.principal,
    },
    threshold: {
      count: alert.threshold.count,
      windowSeconds: alert.threshold["window-seconds"],
    },
    action: alert.action.type === "webhook"
      ? { type: "webhook" as const, url: alert.action.url! }
      : { type: "log" as const },
  }));
}
