import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { documentId, documentSection, extractDocument } from '../src/content-loaders/document';
import { rewriteRepositoryLinks } from '../src/content-loaders/links';

describe('repository documentation', () => {
  test('maps source paths to stable docs routes', () => {
    expect(documentId('deploy/README.md')).toBe('docs/deploy');
    expect(documentId('runbooks/ingest-down.md')).toBe('docs/runbooks/ingest-down');
    expect(documentId('PROJECT_OVERVIEW.md')).toBe('docs/project-overview');
  });

  test('classifies documentation for navigation and search', () => {
    expect(documentSection('deploy/kubernetes.md')).toBe('deployment');
    expect(documentSection('runbooks/ingest-down.md')).toBe('operations');
    expect(documentSection('research/assessment.md')).toBe('research');
  });

  test('derives metadata and removes the duplicate page heading', () => {
    expect(
      extractDocument('# Example — Internal suffix\n\nA concise introduction.\n\n## Detail'),
    ).toEqual({
      body: 'A concise introduction.\n\n## Detail',
      description: 'A concise introduction.',
      title: 'Example',
    });
  });

  test('rewrites docs links to site routes and source links to GitHub', () => {
    const repositoryRoot = '/repo';
    const docsRoot = path.join(repositoryRoot, 'docs');
    const filePath = path.join(docsRoot, 'deploy', 'README.md');
    const target = path.join(docsRoot, 'deploy', 'kubernetes.md');
    const markdown = '[Kubernetes](./kubernetes.md) [Root](../../README.md)';
    expect(
      rewriteRepositoryLinks({
        base: '/ai-agents-observability',
        docsRoot,
        filePath,
        knownFiles: new Set([filePath, target]),
        markdown,
        repositoryRoot,
      }),
    ).toBe(
      '[Kubernetes](/ai-agents-observability/docs/deploy/kubernetes/) [Root](https://github.com/yorch/ai-agents-observability/blob/main/README.md)',
    );
  });
});
