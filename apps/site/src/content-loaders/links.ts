import path from 'node:path';
import { documentId } from './document';

const REPOSITORY_URL = 'https://github.com/yorch/ai-agents-observability/blob/main';
const MARKDOWN_LINK = /(\[[^\]]*\]\()([^\s)]+)([^)]*\))/g;

function withBase(base: string, route: string): string {
  const prefix = base === '/' ? '' : `/${base.replace(/^\/+|\/+$/g, '')}`;
  return `${prefix}/${route.replace(/^\/+|\/+$/g, '')}/`;
}

export function rewriteRepositoryLinks({
  base,
  docsRoot,
  filePath,
  knownFiles,
  markdown,
  repositoryRoot,
}: {
  base: string;
  docsRoot: string;
  filePath: string;
  knownFiles: ReadonlySet<string>;
  markdown: string;
  repositoryRoot: string;
}): string {
  return markdown.replace(MARKDOWN_LINK, (match, opening, target, closing) => {
    if (/^(?:[a-z]+:|#)/i.test(target)) {
      return match;
    }
    const [targetPath, fragment = ''] = target.split('#', 2);
    if (!targetPath) {
      return match;
    }
    const resolved = path.resolve(path.dirname(filePath), decodeURIComponent(targetPath));
    if (knownFiles.has(resolved) && resolved.toLowerCase().endsWith('.md')) {
      const relative = path.relative(docsRoot, resolved);
      const route = withBase(base, documentId(relative));
      return `${opening}${route}${fragment ? `#${fragment}` : ''}${closing}`;
    }
    const relativeToRepository = path.relative(repositoryRoot, resolved).replaceAll(path.sep, '/');
    if (!relativeToRepository.startsWith('..')) {
      const suffix = fragment ? `#${fragment}` : '';
      return `${opening}${REPOSITORY_URL}/${relativeToRepository}${suffix}${closing}`;
    }
    return match;
  });
}
