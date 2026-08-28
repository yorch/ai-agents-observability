import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Loader, LoaderContext } from 'astro/loaders';
import { documentId, documentSection, extractDocument } from './document';
import { rewriteRepositoryLinks } from './links';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const DOCS_ROOT = path.join(REPOSITORY_ROOT, 'docs');
const INDEX_MARKDOWN = `Agentometry documents the architecture, deployment, operation, and design of a self-hosted observability platform for AI coding agents.

## Start here

- [Project overview](./project-overview/) explains the product, its users, and its architecture.
- [Deployment options](./deploy/) compares Docker Compose, Kubernetes, air-gapped, and binary installations.
- [GitHub App setup](./github-app-setup/) connects agent sessions to pull requests and delivery outcomes.
- [Service level objectives](./slos/) and the [on-call guide](./on-call/) cover production operation.

## Source of truth

These pages are rendered directly from the repository's root \`docs/\` directory. The website does not maintain a second copy.`;

async function markdownFiles(): Promise<string[]> {
  const entries = await readdir(DOCS_ROOT, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

async function syncDocumentation(context: LoaderContext): Promise<void> {
  const files = await markdownFiles();
  const knownFiles = new Set(files);
  context.store.clear();
  const indexData = await context.parseData({
    data: {
      description: 'Architecture, deployment, operations, and research for Agentometry.',
      title: 'Documentation',
    },
    id: 'docs',
  });
  context.store.set({
    body: INDEX_MARKDOWN,
    data: indexData,
    filePath: 'src/content/docs/docs.md',
    id: 'docs',
    rendered: await context.renderMarkdown(INDEX_MARKDOWN),
  });

  for (const filePath of files) {
    const relativePath = path.relative(DOCS_ROOT, filePath);
    const id = documentId(relativePath);
    const source = await readFile(filePath, 'utf8');
    const document = extractDocument(source);
    const body = rewriteRepositoryLinks({
      base: context.config.base,
      docsRoot: DOCS_ROOT,
      filePath,
      knownFiles,
      markdown: document.body,
      repositoryRoot: REPOSITORY_ROOT,
    });
    const section = documentSection(relativePath);
    const data = await context.parseData({
      data: {
        description: document.description,
        pagefind: section !== 'research' && section !== 'design',
        title: document.title,
      },
      id,
    });
    context.store.set({
      body,
      data,
      filePath: `src/content/docs/${id}.md`,
      id,
      rendered: await context.renderMarkdown(body, { fileURL: pathToFileURL(filePath) }),
    });
  }
}

export function repositoryDocsLoader(): Loader {
  return {
    load: async (context) => {
      await syncDocumentation(context);
      context.watcher?.add(DOCS_ROOT);
      for (const event of ['add', 'change', 'unlink'] as const) {
        context.watcher?.on(event, async (filePath) => {
          if (filePath.startsWith(DOCS_ROOT) && filePath.toLowerCase().endsWith('.md')) {
            await syncDocumentation(context);
          }
        });
      }
    },
    name: 'agentometry-repository-docs',
  };
}
