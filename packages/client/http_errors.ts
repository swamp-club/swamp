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

// delegated secrets (swda1, swdr1, swdx1) and integration credentials (swi1)
const SECRET_PATTERN = /\bsw(?:d[axr]1|i1)\.[^\s"'`.]+\.[^\s"'`]+/g;

/** replaces anything shaped like a swamp credential or delegated token */
export function scrubSecrets(text: string): string {
  return text.replace(SECRET_PATTERN, "[redacted]");
}

/**
 * client-side codes, beside the codes serve answers with: route_unavailable
 * (an older serve has no such route), action_unavailable,
 * connection_refused, network_error, timeout, unexpected_reply, link_ended
 * and not_admitted
 */
export type SwampHttpErrorCode = string;

export interface SwampHttpErrorInit {
  readonly status: number;
  readonly code: SwampHttpErrorCode;
  readonly message: string;
  readonly route: string;
  readonly actionType?: string;
  readonly requestId?: string;
  readonly retryAfterSeconds?: number;
  readonly reason?: string;
}

/**
 * a refused or failed HTTP call; carries no URL, header, body or cause, so
 * nothing it prints or serialises can hold a credential
 */
export class SwampHttpError extends Error {
  readonly status: number;
  readonly code: SwampHttpErrorCode;
  readonly route: string;
  readonly actionType?: string;
  readonly requestId?: string;
  readonly retryAfterSeconds?: number;
  /** why a refresh was refused, when serve said */
  readonly reason?: string;

  constructor(init: SwampHttpErrorInit) {
    super(scrubSecrets(init.message));
    this.name = "SwampHttpError";
    this.status = init.status;
    this.code = init.code;
    this.route = init.route;
    if (init.actionType !== undefined) this.actionType = init.actionType;
    if (init.requestId !== undefined) this.requestId = init.requestId;
    if (init.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = init.retryAfterSeconds;
    }
    if (init.reason !== undefined) this.reason = init.reason;
  }

  /** the link is gone: the person has to link again */
  get linkEnded(): boolean {
    return this.code === "link_ended";
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      status: this.status,
      code: this.code,
      route: this.route,
      ...(this.actionType !== undefined ? { actionType: this.actionType } : {}),
      ...(this.requestId !== undefined ? { requestId: this.requestId } : {}),
      ...(this.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: this.retryAfterSeconds }
        : {}),
      ...(this.reason !== undefined ? { reason: this.reason } : {}),
    };
  }
}
