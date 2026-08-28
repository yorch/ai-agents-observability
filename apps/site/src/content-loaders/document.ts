import path from 'node:path';

export type DocumentSection = 'deployment' | 'design' | 'operations' | 'platform' | 'research';

const SECTION_BY_DIRECTORY: Record<string, DocumentSection> = {
  deploy: 'deployment',
  design: 'design',
  plans: 'research',
  research: 'research',
  runbooks: 'operations',
  specs: 'research',
};

export function documentId(relativePath: string): string {
  const normalized = relativePath.replaceAll(path.sep, '/').replace(/\.md$/i, '');
  const withoutIndex = normalized.replace(/(^|\/)README$/i, '$1index');
  const slug = withoutIndex
    .split('/')
    .map((segment) => segment.replaceAll('_', '-').toLowerCase())
    .join('/')
    .replace(/\/index$/, '');
  return slug === 'index' ? 'docs' : `docs/${slug}`;
}

export function documentSection(relativePath: string): DocumentSection {
  const [directory] = relativePath.replaceAll(path.sep, '/').split('/');
  if (directory && SECTION_BY_DIRECTORY[directory]) {
    return SECTION_BY_DIRECTORY[directory];
  }
  if (relativePath === 'on-call.md' || relativePath === 'slos.md') {
    return 'operations';
  }
  return 'platform';
}

export function extractDocument(markdown: string): {
  body: string;
  description: string | undefined;
  title: string;
} {
  const heading = markdown.match(/^#\s+(.+)$/m);
  if (!heading?.[1]) {
    throw new Error('Published documentation must contain a level-one heading.');
  }
  const body = markdown.replace(`${heading[0]}\n`, '').trimStart();
  const description = body
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/^>\s?/gm, '').replace(/\s+/g, ' ').trim())
    .find((paragraph) => paragraph && !paragraph.startsWith('#') && paragraph !== '---');
  return {
    body,
    description: description?.slice(0, 180),
    title: heading[1].replace(/\s+—\s+.+$/, '').trim(),
  };
}
