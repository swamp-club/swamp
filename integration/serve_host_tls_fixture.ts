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

// test-only: a CA and a localhost / 127.0.0.1 certificate it signed, valid for
// a century so the test never meets an expired certificate

export const TEST_CA_PEM = `-----BEGIN CERTIFICATE-----
MIIBjDCCATKgAwIBAgIUVN8dgQcD5/C2QDRoi2WcPS9aBUgwCgYIKoZIzj0EAwIw
IzEhMB8GA1UEAwwYc3dhbXAgc2VydmUgaG9zdCB0ZXN0IENBMCAXDTI2MTExNzE3
MTY1NloYDzIxMjYxMDI0MTcxNjU2WjAjMSEwHwYDVQQDDBhzd2FtcCBzZXJ2ZSBo
b3N0IHRlc3QgQ0EwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAQFN6KiGeeXQCtg
q9j22e3HATmOYXhk6RXdIV6Lk8iQpG21xHHIKHWYm5v7LhRpXuBg4cSK90THeKDx
7HQNrbXXo0IwQDAdBgNVHQ4EFgQUsYpk078tQs05eg8JpQyy6RlQ9DIwDwYDVR0T
AQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCAQYwCgYIKoZIzj0EAwIDSAAwRQIgLCFb
0o/TSafDyAIIeKDCi9MyZ3Q8GV1Ts/AK10KieBQCIQD6u2sBHH3eGnwLD0H5NaYa
tjw9Q5Vva7oyq8l/bT9PJA==
-----END CERTIFICATE-----
`;

export const TEST_LOCALHOST_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIBjTCCATKgAwIBAgIUaKS4aPmLE2V3lRl9ya3OFW1krGswCgYIKoZIzj0EAwIw
IzEhMB8GA1UEAwwYc3dhbXAgc2VydmUgaG9zdCB0ZXN0IENBMCAXDTI2MTExNzE3
MTY1NloYDzIxMjYxMDI0MTcxNjU2WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTAT
BgcqhkjOPQIBBggqhkjOPQMBBwNCAARnaU8fqUzymA2ucUbIunM8rTgkh4f/rN7o
f6ypY3bJNf7vrWTgyFE+WRfL5CGj5nP8CVHvjSqjh2xusPBXAYdLo1EwTzAMBgNV
HRMBAf8EAjAAMA4GA1UdDwEB/wQEAwIHgDATBgNVHSUEDDAKBggrBgEFBQcDATAa
BgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwCgYIKoZIzj0EAwIDSQAwRgIhAJwm
qs+JinCENpCnP7cBLVE/mj4VbVTyq8+823t/NEhaAiEAvO64LJX5eLabOqYN11Ib
jOMdIaxHy2uwe2LIfR4HAQs=
-----END CERTIFICATE-----
`;

export const TEST_LOCALHOST_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgochw7VqLFSCu2RCJ
jIO7udqvk5expCcRpDRV7OSy6wKhRANCAARnaU8fqUzymA2ucUbIunM8rTgkh4f/
rN7of6ypY3bJNf7vrWTgyFE+WRfL5CGj5nP8CVHvjSqjh2xusPBXAYdL
-----END PRIVATE KEY-----
`;
