import { basename } from 'node:path';

import { isAiotBinary } from './config-wire';

/**
 * The launcher path for services, hook snippets and the on-demand drainer.
 *
 * When running via the Rust launcher, `exe` (process.execPath) is `aiot-runtime`
 * (the Bun-compiled binary). Everything that registers or spawns us must point at
 * the launcher (`aiot`), not the runtime, so that macOS BTM attributes the
 * background activity to our signature rather than Bun's.
 *
 * Cross-compiled distribution binaries carry a target suffix
 * (`aiot-runtime-darwin-arm64`); the sibling launcher is
 * `aiot-darwin-arm64`, so we strip just `runtime` (keeping any target
 * suffix) rather than replacing the whole name.
 */
export function resolvedBinaryPath(exe: string = process.execPath): string {
  if (basename(exe).startsWith('aiot-runtime')) {
    return exe.replace('aiot-runtime', 'aiot');
  }
  return exe;
}

/**
 * True when `exe` (normally process.execPath) is the compiled aiot binary. Shares
 * its predicate with hook ownership, so anything this lets through is something
 * re-install and uninstall will recognise. Under `bun test` it is `bun`, where
 * `bun drain` would silently do nothing — callers that spawn themselves must
 * check this rather than assume a spawn worked.
 */
export function isCompiledBinary(exe: string = process.execPath): boolean {
  return isAiotBinary(exe);
}
