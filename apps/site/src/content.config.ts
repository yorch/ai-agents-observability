import { defineCollection } from 'astro:content';
import { docsSchema } from '@astrojs/starlight/schema';
import { repositoryDocsLoader } from './content-loaders/repository-docs';

export const collections = {
  docs: defineCollection({
    loader: repositoryDocsLoader(),
    schema: docsSchema(),
  }),
};
