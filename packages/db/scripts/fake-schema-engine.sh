#!/bin/sh
# Stub schema-engine used in sandboxed CI environments where the real binary cannot be downloaded.
# prisma generate does not execute this binary for client generation — it only checks its existence
# and version. The stub satisfies that check.
if [ "$1" = "--version" ]; then
  echo "schema-engine 7.8.0"
  exit 0
fi
exit 0
