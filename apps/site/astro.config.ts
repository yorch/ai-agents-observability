import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import { BRAND } from './src/brand';

const base = process.env.SITE_BASE ?? '/';

export default defineConfig({
  base,
  integrations: [
    starlight({
      customCss: ['./src/styles/starlight.css'],
      description: BRAND.description,
      disable404Route: true,
      favicon: '/favicon.svg',
      sidebar: [
        {
          items: [
            { label: 'Documentation', slug: 'docs' },
            { label: 'Project overview', slug: 'docs/project-overview' },
            { label: 'GitHub App setup', slug: 'docs/github-app-setup' },
          ],
          label: 'Start here',
        },
        {
          items: [{ autogenerate: { directory: 'docs/deploy' } }],
          label: 'Deployment',
        },
        {
          items: [
            { label: 'Service level objectives', slug: 'docs/slos' },
            { label: 'On-call guide', slug: 'docs/on-call' },
            { autogenerate: { directory: 'docs/runbooks' } },
          ],
          label: 'Operations',
        },
        {
          collapsed: true,
          items: [{ autogenerate: { directory: 'docs/design' } }],
          label: 'Design archive',
        },
        {
          collapsed: true,
          items: [{ autogenerate: { directory: 'docs/research' } }],
          label: 'Research archive',
        },
        {
          collapsed: true,
          items: [
            { autogenerate: { directory: 'docs/plans' } },
            { autogenerate: { directory: 'docs/specs' } },
          ],
          label: 'Engineering archive',
        },
      ],
      social: [{ href: BRAND.repository, icon: 'github', label: 'GitHub' }],
      title: BRAND.name,
    }),
  ],
  site: 'https://yorch.github.io',
  trailingSlash: 'always',
});
