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

//go:build windows

package engine

import (
	"os"
	"os/exec"
	"reflect"
	"strconv"
	"syscall"
	"testing"
	"unsafe"
)

func TestConfigureProtocolPipesUsesPrivateInheritedHandles(t *testing.T) {
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	defer writer.Close()
	cmd := exec.Command("unused-engine")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	args, err := configureProtocolPipes(cmd, reader, writer)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"--input-handle", strconv.FormatUint(uint64(reader.Fd()), 10), "--output-handle", strconv.FormatUint(uint64(writer.Fd()), 10)}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("unexpected protocol args %v", args)
	}
	handles := cmd.SysProcAttr.AdditionalInheritedHandles
	if !reflect.DeepEqual(handles, []syscall.Handle{syscall.Handle(reader.Fd()), syscall.Handle(writer.Fd())}) {
		t.Fatal("private input and output handles must be explicitly inherited")
	}
	if !cmd.SysProcAttr.HideWindow {
		t.Fatal("existing process attributes must be preserved")
	}
	if len(cmd.ExtraFiles) != 0 || cmd.Stdin != nil || cmd.Stdout != nil || cmd.Stderr != nil {
		t.Fatal("Windows protocol isolation must not use ExtraFiles or any ordinary standard stream")
	}
}

func TestJobAccountingNativeLayout(t *testing.T) {
	var accounting jobBasicAccountingInformation
	if unsafe.Sizeof(accounting) != 48 || unsafe.Offsetof(accounting.ActiveProcesses) != 40 {
		t.Fatalf("Job accounting layout does not match winnt.h: size=%d activeOffset=%d", unsafe.Sizeof(accounting), unsafe.Offsetof(accounting.ActiveProcesses))
	}
}
