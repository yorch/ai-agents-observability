import { describe, expect, it } from 'bun:test';

import { resolvedBinaryPath } from './binary-path';

describe('resolvedBinaryPath', () => {
  it('maps the runtime to its sibling launcher', () => {
    expect(resolvedBinaryPath('/home/dev/.local/bin/aiot-runtime')).toBe(
      '/home/dev/.local/bin/aiot',
    );
  });

  it('keeps the target suffix of a cross-compiled runtime', () => {
    expect(resolvedBinaryPath('/opt/aiot/aiot-runtime-linux-x64')).toBe('/opt/aiot/aiot-linux-x64');
    expect(resolvedBinaryPath('/opt/aiot/aiot-runtime-darwin-arm64')).toBe(
      '/opt/aiot/aiot-darwin-arm64',
    );
  });

  it('only rewrites the basename, never a directory that contains "aiot-runtime"', () => {
    expect(resolvedBinaryPath('/opt/aiot-runtime-tools/aiot-runtime-linux-x64')).toBe(
      '/opt/aiot-runtime-tools/aiot-linux-x64',
    );
    expect(resolvedBinaryPath('/opt/aiot-runtime/bin/aiot-runtime')).toBe(
      '/opt/aiot-runtime/bin/aiot',
    );
  });

  it('leaves a launcher, a bare name, or any other executable alone', () => {
    expect(resolvedBinaryPath('/opt/aiot-runtime-tools/aiot')).toBe('/opt/aiot-runtime-tools/aiot');
    expect(resolvedBinaryPath('/opt/aiot-runtime-tools/aiot-linux-x64')).toBe(
      '/opt/aiot-runtime-tools/aiot-linux-x64',
    );
    expect(resolvedBinaryPath('/usr/bin/bun')).toBe('/usr/bin/bun');
    expect(resolvedBinaryPath('aiot-runtime')).toBe('aiot');
  });
});
