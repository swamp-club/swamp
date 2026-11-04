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
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"

	servecontract "github.com/swamp-club/swamp/packages/serve-go"
)

const fenceHandshakeTimeout = 5 * time.Second

type guardianConnection struct {
	connection *net.UnixConn
	writeMu    sync.Mutex
	admitted   bool
}

type unixFence struct {
	directory   string
	listener    *net.UnixListener
	timeout     time.Duration
	mu          sync.Mutex
	connections map[*guardianConnection]struct{}
	sealed      bool
	closed      bool
	failure     error
	failed      chan struct{}
	changed     chan struct{}
	accepted    chan struct{}
	handlers    sync.WaitGroup
	deadline    *time.Timer
	deadlineAt  time.Time
}

func newProcessFence(timeout time.Duration) (processFence, error) {
	// A short private directory keeps sockaddr_un below macOS's path limit even
	// when the operator's TMPDIR is a deeply nested repository path.
	directory, err := os.MkdirTemp("/tmp", "swamp-fence-")
	if err != nil {
		return nil, err
	}
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: filepath.Join(directory, "commands.sock"), Net: "unix"})
	if err != nil {
		_ = os.RemoveAll(directory)
		return nil, err
	}
	f := &unixFence{directory: directory, listener: listener, timeout: timeout, connections: make(map[*guardianConnection]struct{}), failed: make(chan struct{}), changed: make(chan struct{}), accepted: make(chan struct{})}
	go f.accept()
	return f, nil
}
func (f *unixFence) Path() string            { return f.listener.Addr().String() }
func (f *unixFence) Failed() <-chan struct{} { return f.failed }
func (f *unixFence) notifyLocked()           { close(f.changed); f.changed = make(chan struct{}) }
func (f *unixFence) failLocked() {
	if f.failure == nil {
		f.failure = ErrUnconfirmedCommandCleanup
		close(f.failed)
	}
}
func (f *unixFence) accept() {
	defer close(f.accepted)
	for {
		connection, err := f.listener.AcceptUnix()
		if err != nil {
			return
		}
		f.mu.Lock()
		if f.sealed || len(f.connections) >= servecontract.MaxCommandGuardians() {
			f.mu.Unlock()
			_ = connection.Close()
			continue
		}
		registered := &guardianConnection{connection: connection}
		f.connections[registered] = struct{}{}
		f.notifyLocked()
		f.handlers.Add(1)
		f.mu.Unlock()
		go f.handle(registered)
	}
}
func (f *unixFence) handle(guardian *guardianConnection) {
	confirmed := false
	defer func() {
		_ = guardian.connection.Close()
		f.mu.Lock()
		if guardian.admitted && !confirmed {
			f.failLocked()
		}
		delete(f.connections, guardian)
		f.notifyLocked()
		f.mu.Unlock()
		f.handlers.Done()
	}()
	_ = guardian.connection.SetDeadline(time.Now().Add(fenceHandshakeTimeout))
	var message [1]byte
	if _, err := io.ReadFull(guardian.connection, message[:]); err != nil || message[0] != 'R' {
		return
	}
	// Serialize A before K even when engine exit races registration.
	guardian.writeMu.Lock()
	f.mu.Lock()
	if f.sealed {
		f.mu.Unlock()
		guardian.writeMu.Unlock()
		return
	}
	guardian.admitted = true
	f.mu.Unlock()
	_, err := guardian.connection.Write([]byte{'A'})
	if err == nil {
		err = guardian.connection.SetDeadline(time.Time{})
	}
	guardian.writeMu.Unlock()
	if err != nil {
		return
	}
	if _, err = io.ReadFull(guardian.connection, message[:]); err == nil && message[0] == 'C' {
		confirmed = true
	}
}
func (f *unixFence) SetDeadline(deadline time.Time) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed || (!f.deadlineAt.IsZero() && !deadline.Before(f.deadlineAt)) {
		return
	}
	f.deadlineAt = deadline
	if f.deadline != nil {
		f.deadline.Stop()
	}
	f.deadline = time.AfterFunc(max(0, time.Until(deadline)), f.abort)
}
func (f *unixFence) abort() {
	f.mu.Lock()
	if f.closed {
		f.mu.Unlock()
		return
	}
	f.sealed = true
	for guardian := range f.connections {
		if guardian.admitted {
			f.failLocked()
		}
		_ = guardian.connection.Close()
	}
	_ = f.listener.Close()
	f.notifyLocked()
	f.mu.Unlock()
}
func (f *unixFence) SealAndWait() error {
	timer := time.AfterFunc(f.timeout, f.abort)
	defer timer.Stop()
	f.mu.Lock()
	f.sealed = true
	_ = f.listener.Close()
	guardians := make([]*guardianConnection, 0, len(f.connections))
	for guardian := range f.connections {
		guardians = append(guardians, guardian)
	}
	f.mu.Unlock()
	<-f.accepted
	for _, guardian := range guardians {
		guardian.writeMu.Lock()
		f.mu.Lock()
		admitted := guardian.admitted
		f.mu.Unlock()
		if admitted {
			_ = guardian.connection.SetWriteDeadline(time.Now().Add(fenceHandshakeTimeout))
			_, _ = guardian.connection.Write([]byte{'K'})
		} else {
			_ = guardian.connection.Close()
		}
		guardian.writeMu.Unlock()
	}
	f.mu.Lock()
	for len(f.connections) != 0 {
		changed := f.changed
		f.mu.Unlock()
		<-changed
		f.mu.Lock()
	}
	failure := f.failure
	f.mu.Unlock()
	f.handlers.Wait()
	f.Close()
	return failure
}
func (f *unixFence) Close() {
	f.abort()
	<-f.accepted
	f.handlers.Wait()
	f.mu.Lock()
	f.closed = true
	if f.deadline != nil {
		f.deadline.Stop()
	}
	f.mu.Unlock()
	_ = os.RemoveAll(f.directory)
}
