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

package engine

import (
	"errors"
	"time"
)

// A failed cleanup proof is sticky: replacing the engine could run new work
// alongside a surviving command from the old generation.
var ErrUnconfirmedCommandCleanup = errors.New("command cleanup could not be confirmed; confirm prior commands have stopped before restarting the supervisor")

type processFence interface {
	Path() string
	Failed() <-chan struct{}
	SetDeadline(time.Time)
	SealAndWait() error
	Close()
}
