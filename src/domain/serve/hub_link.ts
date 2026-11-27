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
import { normalizedUuid } from "./instance_id.ts";
import { joinIdOf } from "./join_token.ts";

export type HubLinkState =
  | "unjoined"
  | "joining"
  | "joined"
  | "refused"
  | "mismatched";

const hubLinkFields = {
  state: z.enum(["unjoined", "joining", "joined", "refused", "mismatched"]),
  hubUrl: z.string().nullable(),
  memberId: z.string().nullable(),
  memberName: z.string().nullable(),
  hubName: z.string().nullable(),
  joinedAt: z.string().nullable(),
  /** with the join token, enough to replay the join, so no view shows it */
  joinId: z.string().nullable().default(null),
};

// every node of a member team reads this: unknown keys are read past and written back
const HubLinkSchema = z.looseObject(hubLinkFields);

const HubLinkFields = z.strictObject(hubLinkFields);

export type HubLinkProps = z.infer<typeof HubLinkFields>;

/** what a join reply says about the member, never its credential */
export interface JoinedMember {
  readonly memberId: string;
  readonly memberName: string;
  readonly hubName: string;
  readonly joinedAt: string;
}

export class HubLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HubLinkError";
  }
}

const UNJOINED: HubLinkProps = {
  state: "unjoined",
  hubUrl: null,
  memberId: null,
  memberName: null,
  hubName: null,
  joinedAt: null,
  joinId: null,
};

/**
 * a member's link to its one hub; only a joining link holds its joinId, and
 * once settled, only a joined or mismatched link holds a credential
 */
export class HubLink {
  private constructor(private readonly props: HubLinkProps) {}

  static unjoined(): HubLink {
    return new HubLink(UNJOINED);
  }

  static fromJSON(json: unknown): HubLink {
    const props = HubLinkSchema.parse(json);
    const memberId = props.memberId === null
      ? null
      : normalizedUuid(props.memberId);
    if (memberId === undefined) {
      throw new HubLinkError(
        "The hub link names a member id that is not a UUID",
      );
    }
    if (
      (props.state === "joined" || props.state === "mismatched" ||
        props.state === "refused") &&
      (props.hubUrl === null || memberId === null)
    ) {
      throw new HubLinkError(
        `A ${props.state} hub link needs a hub and member`,
      );
    }
    if (props.state === "joining" && props.hubUrl === null) {
      throw new HubLinkError("A joining hub link needs a hub");
    }
    // a joining record from before joinId reads with none; its retry takes a fresh one
    if (props.joinId !== null && joinIdOf(props.joinId) === undefined) {
      throw new HubLinkError("A hub link's joinId must be a lower-case UUID");
    }
    if (props.state !== "joining" && props.joinId !== null) {
      throw new HubLinkError(`A ${props.state} hub link holds no joinId`);
    }
    return new HubLink({ ...props, memberId });
  }

  toJSON(): HubLinkProps {
    return { ...this.props };
  }

  get state(): HubLinkState {
    return this.props.state;
  }

  get hubUrl(): string | null {
    return this.props.hubUrl;
  }

  get memberId(): string | null {
    return this.props.memberId;
  }

  get memberName(): string | null {
    return this.props.memberName;
  }

  get hubName(): string | null {
    return this.props.hubName;
  }

  get joinedAt(): string | null {
    return this.props.joinedAt;
  }

  get joinId(): string | null {
    return this.props.joinId;
  }

  get checksIn(): boolean {
    return this.props.state === "joined";
  }

  get holdsCredential(): boolean {
    return this.props.state === "joined" || this.props.state === "mismatched";
  }

  /**
   * a refused or unjoined link may join any hub: a refused one is already dead.
   * A joining link keeps its joinId, so the retry replays the join the hub may
   * already have accepted
   */
  beginJoin(hubUrl: string, freshJoinId: string): HubLink {
    this.#expect(["unjoined", "refused", "joining"], "begin a join");
    const joinId = this.props.state === "joining" && this.props.joinId !== null
      ? this.props.joinId
      : joinIdOf(freshJoinId);
    if (joinId === undefined) {
      throw new HubLinkError("A join needs a lower-case UUID joinId");
    }
    return new HubLink({ ...UNJOINED, state: "joining", hubUrl, joinId });
  }

  /** the hub refused the join for good; a later join starts afresh */
  abandonJoin(): HubLink {
    this.#expect(["joining"], "abandon a join");
    return HubLink.unjoined();
  }

  /** the join reply, recorded before the credential is stored */
  received(member: JoinedMember): HubLink {
    this.#expect(["joining"], "record a join reply");
    const memberId = normalizedUuid(member.memberId);
    if (memberId === undefined) {
      throw new HubLinkError(
        "A join reply named a member id that is not a UUID",
      );
    }
    return new HubLink({
      ...this.props,
      memberId,
      memberName: member.memberName,
      hubName: member.hubName,
      joinedAt: member.joinedAt,
    });
  }

  /** once the credential is stored */
  joined(): HubLink {
    this.#expect(["joining", "mismatched"], "mark joined");
    if (this.props.memberId === null) {
      throw new HubLinkError("A hub link cannot be joined before a join reply");
    }
    return new HubLink({ ...this.props, state: "joined", joinId: null });
  }

  withHubName(hubName: string): HubLink {
    if (this.props.hubName === hubName) return this;
    return new HubLink({ ...this.props, hubName });
  }

  refuse(): HubLink {
    this.#expect(["joined", "mismatched"], "refuse");
    return new HubLink({ ...this.props, state: "refused" });
  }

  mismatch(): HubLink {
    this.#expect(["joined"], "mark mismatched");
    return new HubLink({ ...this.props, state: "mismatched" });
  }

  #expect(states: readonly HubLinkState[], action: string): void {
    if (!states.includes(this.props.state)) {
      throw new HubLinkError(
        `A ${this.props.state} hub link cannot ${action}`,
      );
    }
  }
}

export type StartAction = "check-in" | "join" | "mismatched" | "idle";

export interface StartFacts {
  readonly configuredHubUrl: string;
  /** the member id inside the stored credential, or undefined when none is stored */
  readonly credentialMemberId: string | undefined;
  readonly hasJoinToken: boolean;
}

export interface StartDecision {
  readonly link: HubLink;
  readonly action: StartAction;
  /** a stored credential that belongs to no live link */
  readonly discardCredential: boolean;
}

export function decideStart(stored: HubLink, facts: StartFacts): StartDecision {
  let link = stored;
  const credentialMatches = facts.credentialMemberId !== undefined &&
    facts.credentialMemberId === link.memberId;
  // the credential is stored after the reply and before joined is written;
  // without it the join stays open, to be replayed with the same joinId
  if (link.state === "joining" && credentialMatches) {
    link = link.joined();
  }
  if (link.holdsCredential && !credentialMatches) {
    link = link.refuse();
  }
  if (link.holdsCredential) {
    if (link.hubUrl !== facts.configuredHubUrl) {
      return {
        link: link.state === "mismatched" ? link : link.mismatch(),
        action: "mismatched",
        discardCredential: false,
      };
    }
    return {
      link: link.state === "mismatched" ? link.joined() : link,
      action: "check-in",
      discardCredential: false,
    };
  }
  return {
    link,
    action: facts.hasJoinToken ? "join" : "idle",
    discardCredential: facts.credentialMemberId !== undefined,
  };
}

export const CHECK_IN_RESULTS = [
  "ok",
  "waiting",
  "unreachable",
  "rate_limited",
  "server_error",
  "rejected",
  "instance_limit",
  "refused",
  "join_refused",
  "name_taken",
] as const;

export type CheckInResult = typeof CHECK_IN_RESULTS[number];

const instanceFields = {
  instanceId: z.string(),
  startedAt: z.string(),
  /** refreshed while serve runs, whatever the link state */
  aliveAt: z.string(),
  lastAttemptAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  nextAttemptAt: z.string().nullable(),
  stoppedAt: z.string().nullable(),
};

/** what this serve writes: only results it knows */
export const HubLinkInstanceSchema = z.looseObject({
  ...instanceFields,
  result: z.enum(CHECK_IN_RESULTS).nullable(),
});

/** what any serve on the link reads: a newer serve's result reads as written */
export const HubLinkInstanceRecordSchema = z.looseObject({
  ...instanceFields,
  result: z.string().nullable(),
});

const HubLinkInstanceFields = z.strictObject({
  ...instanceFields,
  result: z.string().nullable(),
});

export type HubLinkInstance = z.infer<typeof HubLinkInstanceFields>;

/** a serve on this link counts as running while it refreshed aliveAt within this window */
export const INSTANCE_ALIVE_WINDOW_MS = 2 * 60 * 1000;

export function isInstanceAlive(
  instance: HubLinkInstance,
  now: number,
  windowMs = INSTANCE_ALIVE_WINDOW_MS,
): boolean {
  if (instance.stoppedAt !== null) return false;
  return now - Date.parse(instance.aliveAt) <= windowMs;
}

/** a member's link to its hub as reported; it carries no credential and no token */
export interface HubLinkView {
  readonly state: HubLinkState;
  readonly hubUrl: string | null;
  /** the hub serve.yaml names, which a mismatched link differs from */
  readonly configuredHubUrl: string;
  readonly hubName: string | null;
  readonly memberName: string | null;
  readonly memberId: string | null;
  readonly joinedAt: string | null;
  readonly instances: HubLinkInstance[];
}
