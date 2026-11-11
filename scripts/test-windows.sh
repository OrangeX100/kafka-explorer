#!/bin/sh
# Windows AV workaround (see Taskfile test:windows): build each package's
# test binary to a FIXED path, then execute. Real-time scanners deny exec of
# freshly-built *.test.exe under go-build's random temp dirs; a stable
# path+name does not trip them. CI and unix machines should use plain
# `go test ./...` instead (test:unix).
set -u
cd "$(dirname "$0")/.."
mkdir -p .gotmp
rc=0
for p in $(go list -f '{{if or .TestGoFiles .XTestGoFiles}}{{.ImportPath}}{{end}}' ./...); do
  name=$(echo "$p" | sed 's|^kafkaexplorer/||; s|/|-|g')
  echo "--- $p"
  if go test -c -o ".gotmp/test-$name.exe" "$p"; then
    ".gotmp/test-$name.exe" || rc=1
  else
    rc=1
  fi
done
# Clean the test binaries up: they linger in a fixed path inside the repo
# and 360's ML engine has flagged freshly-built ones as HEUR/Malware.Gen.
# They are deterministic rebuilds, so nothing is lost by deleting them.
rm -f .gotmp/*.exe
exit $rc
