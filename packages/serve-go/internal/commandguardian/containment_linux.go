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

package commandguardian

import (
	"errors"
	"golang.org/x/sys/unix"
	"time"
)

func prepareContainment() error {
	return unix.Prctl(unix.PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0)
}

func confirmGroupExit(pgid int) error {
	deadline := time.Now().Add(5 * time.Second)
	for {
		var status unix.WaitStatus
		pid, err := unix.Wait4(-pgid, &status, unix.WNOHANG, nil)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil && !errors.Is(err, unix.ECHILD) {
			return err
		}
		if pid > 0 {
			continue
		}
		if err := unix.Kill(-pgid, 0); errors.Is(err, unix.ESRCH) {
			return nil
		} else if err != nil {
			return err
		}
		if !time.Now().Before(deadline) {
			return errors.New("command group cleanup unconfirmed")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
