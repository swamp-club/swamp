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

import { z } from "zod";
import { canonicalJson } from "../expressions/expression_references.ts";
import {
  Fingerprint,
  FingerprintRecordSchema,
  FingerprintSchema,
} from "./fingerprint.ts";
import { type InstanceId, normalizedUuid } from "./instance_id.ts";
import { MemberName } from "./member_name.ts";

export const CHECK_IN_INTERVAL_SECONDS = 30;
const CHECK_IN_INTERVAL_MS = CHECK_IN_INTERVAL_SECONDS * 1000;
export const STALE_AFTER_MS = 3 * CHECK_IN_INTERVAL_MS;
export const OFFLINE_AFTER_MS = 10 * 60 * 1000;
export const INSTANCE_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_INSTANCES = 64;

export const MemberRoleSchema = z.enum(["member", "hub"]);
export type MemberRole = z.infer<typeof MemberRoleSchema>;

export const MemberStatusSchema = z.enum([
  "online",
  "stale",
  "offline",
  "removed",
]);
export type MemberStatus = z.infer<typeof MemberStatusSchema>;

const uuid = z.string().refine((value) => normalizedUuid(value) === value);

const instanceFields = {
  instanceId: uuid,
  swampVersion: z.string(),
  firstSeen: z.string().datetime(),
};

const InstanceRecordFields = z.strictObject(instanceFields);

export type InstanceRecord = z.infer<typeof InstanceRecordFields>;

// lastSeen and the credential hash live in the control-plane store, so an
// unchanged check-in leaves this record, and its data version, alone
const memberFields = {
  memberId: uuid,
  name: z.string().refine((value) => MemberName.problem(value) === undefined),
  role: MemberRoleSchema,
  status: MemberStatusSchema,
  joinedAt: z.string().datetime(),
  removedAt: z.string().datetime().optional(),
};

const ServeMemberRecordFields = z.strictObject({
  ...memberFields,
  fingerprint: FingerprintSchema,
  instances: z.array(InstanceRecordFields).max(MAX_INSTANCES),
});

/** every hub of a team reads this: unknown keys from a newer hub are read past and written back */
export const ServeMemberRecordSchema = z.looseObject({
  ...memberFields,
  fingerprint: FingerprintRecordSchema,
  instances: z.array(z.looseObject(instanceFields)).max(MAX_INSTANCES),
});

export type ServeMemberRecord = z.output<typeof ServeMemberRecordFields>;

export class Instance {
  private constructor(private readonly record: InstanceRecord) {}

  static first(id: InstanceId, swampVersion: string, now: number): Instance {
    return new Instance({
      instanceId: id.value,
      swampVersion,
      firstSeen: new Date(now).toISOString(),
    });
  }

  static fromRecord(record: InstanceRecord): Instance {
    return new Instance({ ...record });
  }

  get instanceId(): string {
    return this.record.instanceId;
  }

  get swampVersion(): string {
    return this.record.swampVersion;
  }

  get firstSeen(): string {
    return this.record.firstSeen;
  }

  withSwampVersion(swampVersion: string): Instance {
    return new Instance({ ...this.record, swampVersion });
  }

  toJSON(): InstanceRecord {
    return { ...this.record };
  }
}

export type CheckInResult =
  | {
    readonly ok: true;
    /** the same object as before when nothing needs writing */
    readonly member: ServeMember;
    readonly changed: boolean;
  }
  | { readonly ok: false; readonly refusal: "removed" | "instance-limit" };

export interface SeenResult {
  readonly member: ServeMember;
  readonly changed: boolean;
  /** instances past INSTANCE_TTL_MS, whose seen keys may go */
  readonly prunedInstanceIds: readonly string[];
}

export interface JoinProps {
  readonly memberId: string;
  readonly name: MemberName;
  readonly role: MemberRole;
  readonly fingerprint: Fingerprint;
  readonly now: number;
}

export type Liveness = "live" | "stale" | "offline";

/** an instance's state from its last check-in age; a member's status is its freshest instance's */
export function livenessFor(ageMs: number): Liveness {
  if (ageMs < STALE_AFTER_MS) return "live";
  if (ageMs < OFFLINE_AFTER_MS) return "stale";
  return "offline";
}

const STATUS_BY_LIVENESS: Readonly<Record<Liveness, MemberStatus>> = {
  live: "online",
  stale: "stale",
  offline: "offline",
};

function statusFor(ageMs: number): MemberStatus {
  return STATUS_BY_LIVENESS[livenessFor(ageMs)];
}

export class ServeMember {
  private constructor(
    private readonly record: Omit<
      ServeMemberRecord,
      "instances" | "fingerprint"
    >,
    readonly fingerprint: Fingerprint,
    readonly instances: readonly Instance[],
  ) {}

  static join(props: JoinProps): ServeMember {
    const memberId = normalizedUuid(props.memberId);
    if (memberId === undefined) {
      throw new Error("A member's id must be a UUID");
    }
    return new ServeMember(
      {
        memberId,
        name: props.name.value,
        role: props.role,
        status: "online",
        joinedAt: new Date(props.now).toISOString(),
      },
      props.fingerprint,
      [],
    );
  }

  static fromJSON(json: unknown): ServeMember {
    const { instances, fingerprint, ...rest } = ServeMemberRecordSchema.parse(
      json,
    );
    return new ServeMember(
      rest as Omit<ServeMemberRecord, "instances" | "fingerprint">,
      Fingerprint.fromRecord(fingerprint),
      instances.map((record) => Instance.fromRecord(record)),
    );
  }

  get memberId(): string {
    return this.record.memberId;
  }

  get name(): string {
    return this.record.name;
  }

  get role(): MemberRole {
    return this.record.role;
  }

  get status(): MemberStatus {
    return this.record.status;
  }

  get joinedAt(): string {
    return this.record.joinedAt;
  }

  get removedAt(): string | undefined {
    return this.record.removedAt;
  }

  get isRemoved(): boolean {
    return this.record.status === "removed";
  }

  instanceIds(): string[] {
    return this.instances.map((instance) => instance.instanceId).sort();
  }

  /**
   * the change rule: a new data version only for configuration drift, a pool
   * change, a status or role change or a different instance set, never runtime
   * fields
   */
  needsNewVersionFrom(previous: ServeMember | null): boolean {
    if (previous === null) return true;
    return this.fingerprint.hash() !== previous.fingerprint.hash() ||
      canonicalJson(this.fingerprint.fields().workers) !==
        canonicalJson(previous.fingerprint.fields().workers) ||
      this.status !== previous.status ||
      this.record.role !== previous.record.role ||
      canonicalJson(this.instanceIds()) !==
        canonicalJson(previous.instanceIds());
  }

  checkIn(
    instanceId: InstanceId,
    fingerprint: Fingerprint,
    now: number,
  ): CheckInResult {
    if (this.isRemoved) return { ok: false, refusal: "removed" };
    const swampVersion = fingerprint.fields().swampVersion;
    const known = this.instances.some((i) => i.instanceId === instanceId.value);
    if (!known && this.instances.length >= MAX_INSTANCES) {
      return { ok: false, refusal: "instance-limit" };
    }
    const instances = known
      ? this.instances.map((i) =>
        i.instanceId === instanceId.value ? i.withSwampVersion(swampVersion) : i
      )
      : [...this.instances, Instance.first(instanceId, swampVersion, now)];
    const next = new ServeMember(
      { ...this.record, status: "online" },
      fingerprint,
      instances,
    );
    return next.needsNewVersionFrom(this)
      ? { ok: true, member: next, changed: true }
      : { ok: true, member: this, changed: false };
  }

  /** the hub's own fingerprint refresh; its record is always online */
  withFingerprint(
    fingerprint: Fingerprint,
  ): { member: ServeMember; changed: boolean } {
    if (this.isRemoved) return { member: this, changed: false };
    const next = new ServeMember(this.record, fingerprint, this.instances);
    return next.needsNewVersionFrom(this)
      ? { member: next, changed: true }
      : { member: this, changed: false };
  }

  /** the hub's own record lists the one leader serving it now */
  withHubInstance(
    instanceId: InstanceId,
    now: number,
  ): { member: ServeMember; changed: boolean } {
    if (this.isRemoved || this.record.role !== "hub") {
      return { member: this, changed: false };
    }
    const swampVersion = this.fingerprint.fields().swampVersion;
    const current = this.instances.find((i) =>
      i.instanceId === instanceId.value
    );
    const instance = current === undefined
      ? Instance.first(instanceId, swampVersion, now)
      : current.withSwampVersion(swampVersion);
    const next = new ServeMember(this.record, this.fingerprint, [instance]);
    return next.needsNewVersionFrom(this) ||
        current?.swampVersion !== swampVersion
      ? { member: next, changed: true }
      : { member: this, changed: false };
  }

  /**
   * status from the freshest live instance, keyed by instance id to its last
   * check-in; an instance unseen for INSTANCE_TTL_MS is dropped
   */
  applySeen(seen: ReadonlyMap<string, number>, now: number): SeenResult {
    if (this.isRemoved || this.record.role === "hub") {
      return { member: this, changed: false, prunedInstanceIds: [] };
    }
    const kept: Instance[] = [];
    const pruned: string[] = [];
    let freshest = Date.parse(this.joinedAt);
    for (const instance of this.instances) {
      const last = seen.get(instance.instanceId) ??
        Date.parse(instance.firstSeen);
      if (now - last >= INSTANCE_TTL_MS) {
        pruned.push(instance.instanceId);
        continue;
      }
      kept.push(instance);
      freshest = Math.max(freshest, last);
    }
    const next = new ServeMember(
      { ...this.record, status: statusFor(now - freshest) },
      this.fingerprint,
      kept,
    );
    return next.needsNewVersionFrom(this)
      ? { member: next, changed: true, prunedInstanceIds: pruned }
      : { member: this, changed: false, prunedInstanceIds: pruned };
  }

  /** terminal: a removed member never checks in or changes status again */
  remove(now: number): { member: ServeMember; changed: boolean } {
    if (this.isRemoved) return { member: this, changed: false };
    return {
      member: new ServeMember(
        {
          ...this.record,
          status: "removed",
          removedAt: new Date(now).toISOString(),
        },
        this.fingerprint,
        this.instances,
      ),
      changed: true,
    };
  }

  toJSON(): ServeMemberRecord {
    return {
      ...this.record,
      fingerprint: this.fingerprint.toJSON(),
      instances: this.instances.map((instance) => instance.toJSON()),
    };
  }
}
