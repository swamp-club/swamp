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

//go:build linux || darwin

package engine

import (
	"errors"
	"os"
	"os/exec"
	"strconv"
	"syscall"

	"github.com/swamp-club/swamp/packages/serve-go/internal/processgroup"
)

func prepareProcess(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} }

func (p *childProcess) waitContained() error {
	err := p.waitGroupBeforeReaping(func() error { return processgroup.WaitWithoutReaping(p.cmd.Process.Pid) }, p.cmd.Wait)
	if errors.Is(err, ErrUnconfirmedCommandCleanup) {
		// Observation no longer proves PID ownership. Stop protocol admission,
		// request EOF drain, and leave one reaper for this permanently fenced
		// generation; neither a group signal nor an unbounded synchronous wait
		// is safe here. Its cleanup error prohibits an automatic replacement.
		_ = p.in.Close()
		_ = p.out.Close()
		p.startUncertainReaper(p.cmd.Wait)
	}
	return err
}

func configureProtocolPipes(cmd *exec.Cmd, input, output *os.File) ([]string, error) {
	fd := 3 + len(cmd.ExtraFiles)
	cmd.ExtraFiles = append(cmd.ExtraFiles, input, output)
	return []string{"--input-fd", strconv.Itoa(fd), "--output-fd", strconv.Itoa(fd + 1)}, nil
}

func containProcess(cmd *exec.Cmd, _ processFence) (func() error, func(), error) {
	return func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }, func() { _ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }, nil
}
