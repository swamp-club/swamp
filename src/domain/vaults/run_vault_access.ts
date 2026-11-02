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

/**
 * scopes nest and only narrow: allow-lists intersect and the outer policy
 * stays; AsyncLocalStorage reaches a generator body only via next(), so enter
 * the scope in the code that drives next()
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { UserError } from "../errors.ts";

export type VaultAction = "read" | "write";

export interface VaultAccessDecision {
  allowed: boolean;
  grantId?: string;
  reason: string;
  /**
   * set only with keyUnknown: the outcome depends on a condition on the secret
   * key the caller could not supply; allowed is false and the operation that
   * knows the key decides
   */
  undetermined?: boolean;
}

export interface VaultDecideOptions {
  /**
   * a policy reports undetermined rather than decide on a key condition it
   * cannot evaluate
   */
  keyUnknown?: boolean;
}

/**
 * a workflow run records it so a resume is held to the principal that started
 * the run, not whoever resumed it
 */
export interface RunTriggeringPrincipal {
  readonly kind: "user" | "worker" | "service";
  readonly id: string;
  readonly tokenBinding?: {
    readonly name: string;
    readonly createdAt: string;
    readonly principalId: string;
  };
  readonly membership: {
    readonly localGroups: readonly string[];
    readonly idpGroups: readonly string[];
    readonly collectives: readonly string[];
  };
}

/**
 * the serve layer implements it from the triggering principal's grants; the
 * domain never sees grants
 */
export interface VaultPrincipalPolicy {
  readonly principal: string;
  /**
   * recorded on a workflow run so its resumes are held to the same principal;
   * absent when the policy has none to record
   */
  readonly triggeringPrincipal?: RunTriggeringPrincipal;
  decide(
    vaultName: string,
    action: VaultAction,
    secretKey?: string,
    options?: VaultDecideOptions,
  ): VaultAccessDecision | Promise<VaultAccessDecision>;
}

export interface VaultAccessDenial {
  vaultName: string;
  action: VaultAction;
  secretKey?: string;
  principal?: string;
  workflow?: string;
  grantId?: string;
  reason: string;
}

/** Called once per scope for each distinct vault, key and action refused. */
export type VaultAccessDeniedHook = (
  denial: VaultAccessDenial,
) => void | Promise<void>;

export interface RunVaultAccessOptions {
  policy?: VaultPrincipalPolicy;
  allowedVaults?: Iterable<string>;
  allowListSource?: string;
  onDenied?: VaultAccessDeniedHook;
}

export class VaultAccessDeniedError extends UserError {
  constructor(readonly denial: VaultAccessDenial) {
    super(describeDenial(denial), "vault_access_denied");
    this.name = "VaultAccessDeniedError";
  }
}

function describeDenial(denial: VaultAccessDenial): string {
  const verb = denial.action === "read" ? "Reading" : "Writing";
  if (denial.workflow !== undefined) {
    return `${verb} vault '${denial.vaultName}' is refused: it is not in the vaults list of workflow '${denial.workflow}'.`;
  }
  return `${verb} vault '${denial.vaultName}' is refused for ${
    denial.principal ?? "this run"
  }: ${denial.reason}`;
}

interface AllowList {
  readonly names: ReadonlySet<string>;
  readonly source?: string;
}

interface DeniedHookEntry {
  readonly hook: VaultAccessDeniedHook;
  readonly seen: Set<string>;
}

export class RunVaultAccess {
  private constructor(
    readonly policies: readonly VaultPrincipalPolicy[],
    private readonly allowLists: readonly AllowList[],
    private readonly deniedHooks: readonly DeniedHookEntry[],
  ) {}

  static create(options: RunVaultAccessOptions): RunVaultAccess {
    return new RunVaultAccess(
      options.policy ? [options.policy] : [],
      options.allowedVaults !== undefined
        ? [{
          names: new Set(options.allowedVaults),
          source: options.allowListSource,
        }]
        : [],
      options.onDenied ? [{ hook: options.onDenied, seen: new Set() }] : [],
    );
  }

  get allowedVaults(): ReadonlySet<string> | undefined {
    if (this.allowLists.length === 0) return undefined;
    const [first, ...rest] = this.allowLists;
    return new Set(
      [...first.names].filter((name) => rest.every((l) => l.names.has(name))),
    );
  }

  get triggeringPrincipal(): RunTriggeringPrincipal | undefined {
    for (const policy of this.policies) {
      if (policy.triggeringPrincipal) return policy.triggeringPrincipal;
    }
    return undefined;
  }

  /**
   * This access held additionally to `inner`: every policy, allow-list and
   * hook of both applies. Neither side can lift a limit of the other.
   */
  narrowedBy(inner: RunVaultAccess): RunVaultAccess {
    return new RunVaultAccess(
      [...this.policies, ...inner.policies],
      [...this.allowLists, ...inner.allowLists],
      [...this.deniedHooks, ...inner.deniedHooks],
    );
  }

  async decide(
    vaultName: string,
    action: VaultAction,
    secretKey?: string,
    options?: VaultDecideOptions,
  ): Promise<
    | { allowed: true }
    | { allowed: false; denial: VaultAccessDenial }
    | { allowed: false; undetermined: true }
  > {
    for (const list of this.allowLists) {
      if (!list.names.has(vaultName)) {
        return {
          allowed: false,
          denial: {
            vaultName,
            action,
            workflow: list.source ?? "(unnamed)",
            reason: "not in the workflow's vaults list",
          },
        };
      }
    }
    let undetermined = false;
    for (const policy of this.policies) {
      const decision = await policy.decide(
        vaultName,
        action,
        secretKey,
        options,
      );
      if (decision.undetermined === true && options?.keyUnknown === true) {
        undetermined = true;
        continue;
      }
      if (!decision.allowed) {
        return {
          allowed: false,
          denial: {
            vaultName,
            action,
            principal: policy.principal,
            ...(decision.grantId !== undefined
              ? { grantId: decision.grantId }
              : {}),
            reason: decision.reason,
          },
        };
      }
    }
    return undetermined
      ? { allowed: false, undetermined: true }
      : { allowed: true };
  }

  /**
   * with keyUnknown, an outcome that depends on the key is not refused here;
   * the operation that names the key is checked again and decides
   */
  async check(
    vaultName: string,
    action: VaultAction,
    secretKey?: string,
    options?: VaultDecideOptions,
  ): Promise<void> {
    const result = await this.decide(vaultName, action, secretKey, options);
    if (result.allowed || "undetermined" in result) return;
    const denial: VaultAccessDenial = {
      ...result.denial,
      ...(secretKey !== undefined ? { secretKey } : {}),
    };
    const dedupeKey = `${vaultName}\0${secretKey ?? ""}\0${action}`;
    for (const entry of this.deniedHooks) {
      if (entry.seen.has(dedupeKey)) continue;
      entry.seen.add(dedupeKey);
      await entry.hook(denial);
    }
    throw new VaultAccessDeniedError(denial);
  }
}

const ambientVaultAccess = new AsyncLocalStorage<RunVaultAccess | null>();

function scopedAccess(access: RunVaultAccess): RunVaultAccess {
  const outer = currentVaultAccess();
  return outer ? outer.narrowedBy(access) : access;
}

/**
 * for an async generator fn must be the code that calls next() (e.g. the whole
 * for-await loop), since AsyncLocalStorage reaches a generator body only
 * through each next() call
 */
export function runWithVaultAccess<T>(
  access: RunVaultAccess,
  fn: () => T,
): T {
  return ambientVaultAccess.run(scopedAccess(access), fn);
}

export function currentVaultAccess(): RunVaultAccess | undefined {
  return ambientVaultAccess.getStore() ?? undefined;
}

/**
 * Runs `fn` outside any vault access scope, for control-plane work a run
 * triggers (enrollment, lease transitions) that must not be held to the
 * run's principal.
 */
export function withoutVaultAccess<T>(fn: () => T): T {
  return ambientVaultAccess.run(null, fn);
}

export async function* runGeneratorWithVaultAccess<T, R = void>(
  access:
    | RunVaultAccess
    | undefined
    | (() => Promise<RunVaultAccess | undefined>),
  inner: () => AsyncGenerator<T, R>,
): AsyncGenerator<T, R | undefined> {
  const resolved = typeof access === "function" ? await access() : access;
  const outer = currentVaultAccess();
  const scope = resolved === undefined
    ? outer
    : outer
    ? outer.narrowedBy(resolved)
    : resolved;
  if (scope === undefined) {
    return yield* inner();
  }
  const iterator = ambientVaultAccess.run(scope, inner);
  let done = false;
  try {
    while (true) {
      let result: IteratorResult<T, R>;
      try {
        result = await ambientVaultAccess.run(scope, () => iterator.next());
      } catch (error) {
        done = true;
        throw error;
      }
      if (result.done) {
        done = true;
        return result.value;
      }
      yield result.value;
    }
  } finally {
    if (!done) {
      await ambientVaultAccess.run(scope, async () => {
        await iterator.return(undefined as R);
      });
    }
  }
}

export async function* runGeneratorWithoutVaultAccess<T, R = void>(
  inner: () => AsyncGenerator<T, R>,
): AsyncGenerator<T, R | undefined> {
  const iterator = withoutVaultAccess(inner);
  let done = false;
  try {
    while (true) {
      let result: IteratorResult<T, R>;
      try {
        result = await withoutVaultAccess(() => iterator.next());
      } catch (error) {
        done = true;
        throw error;
      }
      if (result.done) {
        done = true;
        return result.value;
      }
      yield result.value;
    }
  } finally {
    if (!done) {
      await withoutVaultAccess(async () => {
        await iterator.return(undefined as R);
      });
    }
  }
}
