import { describe, expect, it } from 'bun:test';

import { getProjectName } from './project';

// ── getProjectName ──────────────────────────────────────────────────────────

describe('getProjectName', () => {
  it('returns the name from package.json in the given directory', () => {
    const read = (p: string) => {
      if (p.endsWith('package.json')) {
        return JSON.stringify({ name: 'my-app' });
      }
      throw new Error('not found');
    };
    expect(getProjectName('/home/user/project', read)).toBe('my-app');
  });

  it('walks up when no package.json at cwd', () => {
    const read = (p: string) => {
      if (p === '/home/user/project/package.json') {
        throw new Error('not found');
      }
      if (p === '/home/user/package.json') {
        return JSON.stringify({ name: 'parent-app' });
      }
      throw new Error('not found');
    };
    expect(getProjectName('/home/user/project', read)).toBe('parent-app');
  });

  it('returns null when no package.json with a name is found', () => {
    const read = (_p: string) => {
      throw new Error('not found');
    };
    expect(getProjectName('/home/user/project', read)).toBeNull();
  });

  it('skips package.json entries with no name field', () => {
    let calls = 0;
    const read = (p: string) => {
      calls++;
      if (p === '/home/user/project/package.json') {
        return JSON.stringify({ version: '1.0.0' }); // no name
      }
      if (p === '/home/user/package.json') {
        return JSON.stringify({ name: 'root-app' });
      }
      throw new Error('not found');
    };
    expect(getProjectName('/home/user/project', read)).toBe('root-app');
    expect(calls).toBe(2);
  });

  it('returns null at filesystem root', () => {
    const read = (_p: string) => {
      throw new Error('not found');
    };
    expect(getProjectName('/', read)).toBeNull();
  });
});
