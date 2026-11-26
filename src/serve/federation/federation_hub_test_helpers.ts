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

import type { ControlPlaneStore } from "../../domain/datastore/control_plane_store.ts";
import { createInMemoryWorkerContext } from "../../domain/models/worker/worker_test_helpers.ts";
import {
  SERVE_MEMBER_DATA_NAME,
  SERVE_MEMBER_MODEL_TYPE,
  serveMemberModel,
} from "../../domain/models/serve/serve_member_model.ts";
import { ServeMember } from "../../domain/serve/serve_member.ts";
import {
  FederationHub,
  type FederationHubOptions,
  type MemberMethodCall,
  type MemberMethodRunner,
  type MemberRecords,
} from "./federation_hub.ts";

export class MemoryControlPlaneStore implements ControlPlaneStore {
  readonly entries = new Map<string, Uint8Array>();
  readonly puts: string[] = [];

  put(key: string, data: Uint8Array): Promise<void> {
    this.entries.set(key, data);
    this.puts.push(key);
    return Promise.resolve();
  }

  get(key: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.entries.get(key) ?? null);
  }

  delete(key: string): Promise<void> {
    this.entries.delete(key);
    return Promise.resolve();
  }

  list(prefix: string): Promise<string[]> {
    return Promise.resolve(
      [...this.entries.keys()].filter((key) => key.startsWith(prefix)).sort(),
    );
  }

  json(key: string): unknown {
    const bytes = this.entries.get(key);
    return bytes === undefined
      ? undefined
      : JSON.parse(new TextDecoder().decode(bytes));
  }
}

/** member records kept by running the real model methods over an in-memory context */
export class InMemoryMembers implements MemberRecords {
  readonly #contexts = new Map<
    string,
    ReturnType<typeof createInMemoryWorkerContext>
  >();
  readonly calls: Array<{ name: string; call: MemberMethodCall }> = [];

  readonly run: MemberMethodRunner = async (name, call) => {
    this.calls.push({ name, call });
    let harness = this.#contexts.get(name);
    if (harness === undefined) {
      harness = createInMemoryWorkerContext(SERVE_MEMBER_MODEL_TYPE, name);
      this.#contexts.set(name, harness);
    }
    await serveMemberModel.methods[call.method].execute(
      call.inputs as unknown as Record<string, unknown>,
      harness.context,
    );
  };

  list(): Promise<ServeMember[]> {
    return Promise.resolve(
      [...this.#contexts.keys()].flatMap((name) => {
        const member = this.#read(name);
        return member === null ? [] : [member];
      }),
    );
  }

  get(name: string): Promise<ServeMember | null> {
    return Promise.resolve(this.#read(name));
  }

  version(name: string): number {
    return this.#contexts.get(name)?.versions.get(SERVE_MEMBER_DATA_NAME) ?? 0;
  }

  raw(name: string): Record<string, unknown> | undefined {
    return this.#contexts.get(name)?.store.get(SERVE_MEMBER_DATA_NAME);
  }

  #read(name: string): ServeMember | null {
    const raw = this.raw(name);
    return raw === undefined ? null : ServeMember.fromJSON(raw);
  }
}

export interface TestHub {
  readonly hub: FederationHub;
  readonly store: MemoryControlPlaneStore;
  readonly members: InMemoryMembers;
  readonly clock: { now: number };
}

export const TEST_NOW = Date.parse("2026-11-26T12:00:00.000Z");

export function createTestHub(
  overrides: Partial<FederationHubOptions> = {},
): TestHub {
  const store = new MemoryControlPlaneStore();
  const members = new InMemoryMembers();
  const clock = { now: TEST_NOW };
  const hub = new FederationHub({
    store,
    hubName: "hub",
    members,
    runMemberMethod: members.run,
    now: () => clock.now,
    ...overrides,
  });
  return { hub, store, members, clock };
}
