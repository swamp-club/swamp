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

package serves

import (
	"errors"
	"io"
	"os/exec"
	"sync"
	"syscall"
	"time"

	"github.com/swamp-club/swamp/packages/serve-go/internal/processgroup"
)

type groupProcess struct {
	cmd    *exec.Cmd
	mu     sync.Mutex
	reaped bool
}

func startProcess(argv []string, dir string, stdout, stderr io.Writer) (Process, error) {
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = dir
	cmd.Stdout, cmd.Stderr = stdout, stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	// A grandchild that left the group must not hold the log pipe open forever.
	cmd.WaitDelay = 5 * time.Second
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return &groupProcess{cmd: cmd}, nil
}

func (p *groupProcess) Pid() int { return p.cmd.Process.Pid }

// signal reaches the group only while the leader is unreaped, so a recycled
// process group id is never signalled.
func (p *groupProcess) signal(sig syscall.Signal) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.reaped {
		return nil
	}
	return syscall.Kill(-p.cmd.Process.Pid, sig)
}

func (p *groupProcess) Terminate() error { return p.signal(syscall.SIGTERM) }
func (p *groupProcess) Kill() error      { return p.signal(syscall.SIGKILL) }

func (p *groupProcess) Wait() (int, error) {
	waitErr := processgroup.WaitWithoutReaping(p.cmd.Process.Pid)
	_ = p.signal(syscall.SIGKILL)
	p.mu.Lock()
	p.reaped = true
	p.mu.Unlock()
	err := p.cmd.Wait()
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return exit.ExitCode(), nil
	}
	if err != nil {
		return -1, errors.Join(waitErr, err)
	}
	return 0, waitErr
}
