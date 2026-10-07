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
 * The vault access a run is held to (swamp-club#2676).
 *
 * A {@link RunVaultAccess} carries up to two limits on which vaults code
 * running inside it may read or write:
 *
 * - a **principal policy** — a port the serve layer implements to decide, per
 *   vault and action, from the grants of the principal that triggered the
 *   run; and
 * - a **workflow allow-list** — the `vaults:` list a workflow author declared
 *   as the most the workflow may touch.
 *
 * The access is ambient: {@link runWithVaultAccess} enters it on an
 * `AsyncLocalStorage`, and `VaultService` reads {@link currentVaultAccess} on
 * every per-vault method before it touches a provider, so every vault service
 * instance a run builds is held to it. With no scope, vault operations behave
 * exactly as they always have.
 *
 * **Nesting only narrows.** A scope entered inside another combines with it:
 * allow-lists intersect, and the outer principal policy is inherited and
 * cannot be replaced — when both supply one, both decide and a refusal from
 * either refuses.
 *
 * **Generators.** `AsyncLocalStorage` reaches an async generator's body only
 * through each `next()` call, from the context of the code that calls it.
 * So the scope must be entered in the code that calls the generator's
 * `next()`: wrapping a `for await` loop that itself runs inside the scope is
 * fine, as is wrapping the generator with {@link runGeneratorWithVaultAccess}
 * or entering the scope inside the code the generator drives. Entering it
 * anywhere outside the code that drives `next()` — around a function that
 * only creates or returns the generator, say — leaves the body unscoped.
 *
 * @module
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { UserError } from "../errors.ts";

/** What a vault operation does: reads a value or key list, or changes one. */
export type VaultAction = "read" | "write";

/** One decision on a vault action. */
export interface VaultAccessDecision {
  allowed: boolean;
  /** The grant that decided, when one did. */
  grantId?: string;
  /** Why, in words fit for an error message (never a secret value). */
  reason: string;
  /**
   * Set only when decided with {@link VaultDecideOptions.keyUnknown}: the
   * outcome depends on a condition on the secret key, which the caller could
   * not supply. `allowed` is then false; the operation that knows the key
   * decides.
   */
  undetermined?: boolean;
}

/** Options for deciding a vault action. */
export interface VaultDecideOptions {
  /**
   * The operation will name a secret key that is not known yet (a sensitive
   * output whose key is generated at write time). A policy then reports
   * `undetermined` rather than decide on a key condition it cannot evaluate.
   */
  keyUnknown?: boolean;
}

/**
 * Who triggered a run and the memberships captured when it started
 * (swamp-club#2676). A workflow run records it, so a later resume is held to
 * the principal that started the run rather than to whoever resumed it.
 */
export interface RunTriggeringPrincipal {
  readonly kind: "user" | "worker" | "service";
  readonly id: string;
  /** The server token the triggering session was opened with, if any. */
  readonly tokenBinding?: {
    readonly name: string;
    readonly createdAt: string;
    readonly principalId: string;
  };
  /** Memberships as of run start. */
  readonly membership: {
    readonly localGroups: readonly string[];
    readonly idpGroups: readonly string[];
    readonly collectives: readonly string[];
  };
}

/**
 * Port for the principal policy a run is held to. The serve layer implements
 * it from the triggering principal's grants; the domain never sees grants.
 */
export interface VaultPrincipalPolicy {
  /** Names the principal in refusals and audit (e.g. `user:alice`). */
  readonly principal: string;
  /**
   * The principal and memberships to record on a workflow run started under
   * this policy, so its resumes are held to the same principal. Absent when
   * the policy has none to record (a resume of a run that recorded none).
   */
  readonly triggeringPrincipal?: RunTriggeringPrincipal;
  decide(
    vaultName: string,
    action: VaultAction,
    secretKey?: string,
    options?: VaultDecideOptions,
  ): VaultAccessDecision | Promise<VaultAccessDecision>;
}

/** A refused vault operation, as reported to an `onDenied` hook. */
export interface VaultAccessDenial {
  vaultName: string;
  action: VaultAction;
  /** The secret key the operation named, when it named one. */
  secretKey?: string;
  /** The principal refused, when a principal policy refused. */
  principal?: string;
  /** The workflow whose `vaults:` list refused, when the list refused. */
  workflow?: string;
  grantId?: string;
  reason: string;
}

/** Called once per scope for each distinct vault, key and action refused. */
export type VaultAccessDeniedHook = (
  denial: VaultAccessDenial,
) => void | Promise<void>;

/** Options for {@link RunVaultAccess.create}. */
export interface RunVaultAccessOptions {
  policy?: VaultPrincipalPolicy;
  /** The vault names a workflow's `vaults:` list allows. */
  allowedVaults?: Iterable<string>;
  /** The workflow that declared `allowedVaults`, named in refusals. */
  allowListSource?: string;
  onDenied?: VaultAccessDeniedHook;
}

/**
 * Refused by the run's vault access. The message names the vault and the
 * principal (or the workflow whose list refused), never a secret value.
 */
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
  /** Denials already reported to `hook`: deduplicated per scope. */
  readonly seen: Set<string>;
}

/**
 * Value object: the vault access a run is held to. Its limits are immutable;
 * the only state that changes is each `onDenied` hook's record of denials
 * already reported, so a scope reports each refusal once. Combining two with
 * {@link narrowedBy} only ever narrows.
 */
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

  /**
   * The vault names every allow-list in this access allows (their
   * intersection), or `undefined` when no list applies.
   */
  get allowedVaults(): ReadonlySet<string> | undefined {
    if (this.allowLists.length === 0) return undefined;
    const [first, ...rest] = this.allowLists;
    return new Set(
      [...first.names].filter((name) => rest.every((l) => l.names.has(name))),
    );
  }

  /**
   * The triggering principal of the outermost policy that records one: the
   * principal a workflow run started under this access is held to on resume.
   */
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

  /**
   * Decides `action` on `vaultName` without reporting a refusal. With
   * `keyUnknown`, the result is `undetermined` when no limit refuses outright
   * but a policy's outcome depends on the key. A workflow's `vaults:` list
   * never depends on the key.
   */
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
   * Refuses `action` on `vaultName` unless every limit allows it: reports the
   * refusal to each `onDenied` hook (once per vault, key and action) and
   * throws {@link VaultAccessDeniedError}. With `keyUnknown`, an outcome that
   * depends on the key is not refused here: the operation that names the key
   * is checked again and decides.
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

/** `null` marks a scope left with {@link withoutVaultAccess}. */
const ambientVaultAccess = new AsyncLocalStorage<RunVaultAccess | null>();

/**
 * The vault access `access` would hold code to when entered here: `access`
 * narrowed by the current scope, if any.
 */
function scopedAccess(access: RunVaultAccess): RunVaultAccess {
  const outer = currentVaultAccess();
  return outer ? outer.narrowedBy(access) : access;
}

/**
 * Runs `fn` held to `access`, narrowed by any scope it is entered from.
 *
 * For an async generator, `fn` must be the code that calls the generator's
 * `next()` — such as the whole `for await` loop that consumes it — because
 * `AsyncLocalStorage` reaches a generator's body only through each `next()`
 * call. A scope entered around code that merely creates or returns the
 * generator, with `next()` called later from outside `fn`, does not reach
 * it. {@link runGeneratorWithVaultAccess} wraps a generator.
 */
export function runWithVaultAccess<T>(
  access: RunVaultAccess,
  fn: () => T,
): T {
  return ambientVaultAccess.run(scopedAccess(access), fn);
}

/** The vault access code is currently held to, or `undefined`. */
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

/**
 * Drives the generator `inner` creates held to `access` (narrowed by the
 * scope the first `next()` is called from): `inner` is created, and every
 * `next()` and a forwarded `return()` run, inside the scope. Values are
 * re-yielded unchanged. Code the consumer runs between values is outside it.
 *
 * `access` may be a function, called once at the first `next()`, so the
 * access can depend on what the caller resolves first; returning `undefined`
 * adds no limit of its own.
 */
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

/**
 * Drives the generator `inner` creates outside any vault access scope, for
 * control-plane work returned as a stream (worker prune): `inner` is created,
 * and every `next()` and a forwarded `return()` run, with no scope.
 */
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
