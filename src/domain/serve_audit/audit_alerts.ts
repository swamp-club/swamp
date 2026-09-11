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

import type { AuditEvent } from "./audit_event.ts";

export interface AlertRuleMatch {
  readonly category?: string;
  readonly action?: string;
  readonly outcome?: string;
  readonly principal?: string;
}

export interface AlertThreshold {
  readonly count: number;
  readonly windowSeconds: number;
}

export type AlertAction =
  | { readonly type: "webhook"; readonly url: string }
  | { readonly type: "log" };

export interface AlertRuleConfig {
  readonly name: string;
  readonly description?: string;
  readonly match: AlertRuleMatch;
  readonly threshold: AlertThreshold;
  readonly action: AlertAction;
}

export type AlertRuleState = "armed" | "triggered" | "cooldown";

export interface AlertRuleStatus {
  readonly name: string;
  readonly description?: string;
  readonly state: AlertRuleState;
  readonly windowCount: number;
  readonly lastFiredAt?: string;
}

export interface AlertFiredEvent {
  readonly ruleName: string;
  readonly ruleDescription?: string;
  readonly matchedEventId: string;
  readonly windowCount: number;
  readonly action: AlertAction;
}

interface RuleState {
  readonly config: AlertRuleConfig;
  readonly windowTimestamps: number[];
  state: AlertRuleState;
  lastFiredAt?: number;
}

function matchesRule(event: AuditEvent, match: AlertRuleMatch): boolean {
  if (match.category !== undefined && event.category !== match.category) {
    return false;
  }
  if (match.action !== undefined && event.action !== match.action) {
    return false;
  }
  if (match.outcome !== undefined && event.outcome !== match.outcome) {
    return false;
  }
  if (match.principal !== undefined && event.principalId !== match.principal) {
    return false;
  }
  return true;
}

export class AlertRuleEngine {
  readonly #rules: RuleState[];
  readonly #now: () => number;

  constructor(configs: readonly AlertRuleConfig[], now?: () => number) {
    this.#now = now ?? (() => Date.now());
    this.#rules = configs.map((config) => ({
      config,
      windowTimestamps: [],
      state: "armed" as AlertRuleState,
    }));
  }

  evaluate(event: AuditEvent): AlertFiredEvent[] {
    if (event.category === "system" && event.action.startsWith("alert.")) {
      return [];
    }

    const now = this.#now();
    const fired: AlertFiredEvent[] = [];

    for (const rule of this.#rules) {
      if (!matchesRule(event, rule.config.match)) continue;

      const windowMs = rule.config.threshold.windowSeconds * 1000;
      const cutoff = now - windowMs;

      rule.windowTimestamps.push(now);
      while (
        rule.windowTimestamps.length > 0 && rule.windowTimestamps[0] <= cutoff
      ) {
        rule.windowTimestamps.shift();
      }

      const count = rule.windowTimestamps.length;

      if (rule.state === "cooldown") {
        if (count < rule.config.threshold.count) {
          rule.state = "armed";
        }
        continue;
      }

      if (count >= rule.config.threshold.count) {
        rule.state = "triggered";
        rule.lastFiredAt = now;
        fired.push({
          ruleName: rule.config.name,
          ruleDescription: rule.config.description,
          matchedEventId: event.id,
          windowCount: count,
          action: rule.config.action,
        });
        rule.state = "cooldown";
      }
    }

    return fired;
  }

  status(): AlertRuleStatus[] {
    return this.#rules.map((rule) => ({
      name: rule.config.name,
      description: rule.config.description,
      state: rule.state,
      windowCount: rule.windowTimestamps.length,
      lastFiredAt: rule.lastFiredAt !== undefined
        ? new Date(rule.lastFiredAt).toISOString()
        : undefined,
    }));
  }
}
