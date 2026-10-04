import { describe, expect, it } from 'bun:test';

import { diffObjectCopy, isClean, type LsjsonEntry } from './verify-object-copy';

const obj = (path: string, meta: Record<string, string> = {}, size = 10): LsjsonEntry => ({
  Metadata: meta,
  Path: path,
  Size: size,
});

describe('diffObjectCopy', () => {
  it('passes identical copies and ignores rclone-stamped times', () => {
    const src = [obj('transcripts/a', { mtime: '1', 'upload-sha256': 'x' })];
    const dst = [obj('transcripts/a', { btime: '2', mtime: '3', 'upload-sha256': 'x' })];
    expect(isClean(diffObjectCopy(src, dst))).toBe(true);
  });

  it('flags a copy that stripped all metadata (what rclone check misses)', () => {
    const src = [obj('transcripts/a', { 'upload-sha256': 'x' })];
    const dst = [obj('transcripts/a', {})];
    const r = diffObjectCopy(src, dst);
    expect(isClean(r)).toBe(false);
    expect(r.mismatched[0]?.reason).toContain('upload-sha256');
    expect(r.sha256Counts).toEqual({ destination: 0, source: 1 });
  });

  it('flags missing objects and size changes', () => {
    const src = [obj('transcripts/a'), obj('judge-rationales/s/v1.json')];
    const dst = [obj('transcripts/a', {}, 99)];
    const r = diffObjectCopy(src, dst);
    expect(r.missing).toEqual(['judge-rationales/s/v1.json']);
    expect(r.mismatched[0]?.reason).toContain('size');
  });

  it('counts per prefix and ignores directories and extra destination objects', () => {
    const src = [obj('transcripts/a'), obj('judge-rationales/s/v1.json')];
    const dst = [...src, obj('transcripts/extra'), { IsDir: true, Path: 'transcripts', Size: 0 }];
    const r = diffObjectCopy(src, dst);
    expect(isClean(r)).toBe(true);
    expect(r.prefixCounts.source).toEqual({ 'judge-rationales/': 1, 'transcripts/': 1 });
    expect(r.prefixCounts.destination['transcripts/']).toBe(2);
  });
});
