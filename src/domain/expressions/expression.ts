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

export interface ExpressionLocation {
  path: string;
  raw: string;
  celExpression: string;
  start?: number;
  end?: number;
  embedded?: boolean;
}

export class Expression {
  private constructor(
    readonly raw: string,
    readonly celExpression: string,
    readonly path: string,
  ) {}

  static create(raw: string, celExpression: string, path: string): Expression {
    return new Expression(raw, celExpression, path);
  }

  static fromLocation(location: ExpressionLocation): Expression {
    return new Expression(location.raw, location.celExpression, location.path);
  }

  toLocation(): ExpressionLocation {
    return {
      path: this.path,
      raw: this.raw,
      celExpression: this.celExpression,
    };
  }
}
