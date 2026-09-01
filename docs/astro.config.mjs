// @ts-check
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import starlight from '@astrojs/starlight';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const legacyDocPaths = [
	'getting-started/introduction',
	'getting-started/installation',
	'getting-started/quick-start',
	'getting-started/concepts',
	'guides/agent-workflow',
	'guides/profiles',
	'guides/stages',
	'guides/plugins',
	'guides/agent-integrations',
	'guides/skill-pack-compatibility',
	'guides/verification',
	'guides/mission-control',
	'guides/upgrading',
	'reference/cli',
	'reference/mcp',
	'reference/harness-files',
	'reference/environment',
	'project/architecture',
	'project/contributing',
	'project/faq',
];

/** @type {Record<string, string>} */
const redirects = Object.fromEntries(
	legacyDocPaths.map((slug) => [`/${slug}`, `/docs/${slug}/`]),
);
// The docs landing was consolidated into the Introduction; send /docs there.
redirects['/docs'] = '/docs/getting-started/introduction/';
redirects['/enterprise'] = 'https://harhq.com/';
redirects['/docs/project/road-to-1-0'] = '/blog/har-1-0-0/';
redirects['/docs/project/road-to-1-0/'] = '/blog/har-1-0-0/';

export default defineConfig({
	site: 'https://harproject.dev',
	base: '/',
	devToolbar: { enabled: false },
	redirects,
	integrations: [
		react(),
		starlight({
			title: 'HAR',
			description:
				'HAR is an open-source agent harness — CLI and MCP server — for multi-agent coding workflows. Isolated worktrees, deterministic verification, and software-factory observability.',
			logo: {
				src: './public/assets/har-logo.png',
				alt: 'HAR',
				replacesTitle: true,
			},
			favicon: '/assets/har-logo.png',
			customCss: [
				'@fontsource-variable/geist/index.css',
				'@fontsource-variable/geist-mono/index.css',
				'./src/styles/custom.css',
			],
			components: {
				// Unify the light/dark toggle with the marketing site (shared
				// `har-theme` key, default dark) — theme mechanism only.
				ThemeProvider: './src/components/docs/ThemeProvider.astro',
				ThemeSelect: './src/components/docs/ThemeSelect.astro',
				// Adds theme-aware Mermaid rendering (lazy-loaded per page).
				Head: './src/components/docs/Head.astro',
				// Point the logo at the docs home instead of the marketing root.
				SiteTitle: './src/components/docs/SiteTitle.astro',
				// Add a "Website" link to the header right cluster.
				SocialIcons: './src/components/docs/SocialIcons.astro',
			},
			disable404Route: true,
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/os-factory/har' },
			],
			editLink: {
				baseUrl: 'https://github.com/os-factory/har/edit/main/docs/',
			},
			lastUpdated: true,
			sidebar: [
				{
					label: 'Start here',
					items: [
						{ label: 'Introduction', slug: 'docs/getting-started/introduction' },
						{ label: 'Installation', slug: 'docs/getting-started/installation' },
						{ label: 'Quick start', slug: 'docs/getting-started/quick-start' },
						{ label: 'Core concepts', slug: 'docs/getting-started/concepts' },
					],
				},
				{
					label: 'Guides',
					items: [
						{ label: 'Agent workflow', slug: 'docs/guides/agent-workflow' },
						{ label: 'Customization contract', slug: 'docs/guides/customization' },
						{ label: 'Profiles & configuration', slug: 'docs/guides/profiles' },
						{ label: 'Stages & artifacts', slug: 'docs/guides/stages' },
						{ label: 'Plugins', slug: 'docs/guides/plugins' },
						{ label: 'Local plugins', slug: 'docs/guides/local-plugins' },
						{ label: 'Agent integrations', slug: 'docs/guides/agent-integrations' },
						{ label: 'Skill-pack compatibility', slug: 'docs/guides/skill-pack-compatibility' },
						{ label: 'Factory lines', slug: 'docs/guides/factory-lines' },
						{ label: 'Verification & commit gate', slug: 'docs/guides/verification' },
						{ label: 'Mission Control', slug: 'docs/guides/mission-control' },
						{ label: 'Eject', slug: 'docs/guides/eject' },
						{ label: 'Upgrade a harness', slug: 'docs/guides/upgrading' },
						{ label: 'Migrating to 1.0', slug: 'docs/guides/migrating-to-1-0' },
					],
				},
				{
					label: 'Reference',
					items: [
						{ label: 'CLI', slug: 'docs/reference/cli' },
						{ label: 'Doctor', slug: 'docs/reference/doctor' },
						{ label: 'MCP tools', slug: 'docs/reference/mcp' },
						{ label: 'Harness files', slug: 'docs/reference/harness-files' },
						{ label: 'Environment variables', slug: 'docs/reference/environment' },
					],
				},
				{
					label: 'Project',
					items: [
						{ label: 'Architecture', slug: 'docs/project/architecture' },
						{ label: 'HAR 1.0.0', link: '/blog/har-1-0-0/' },
						{ label: 'Contributing', slug: 'docs/project/contributing' },
						{ label: 'FAQ', slug: 'docs/project/faq' },
					],
				},
			],
		}),
	],
	vite: {
		resolve: {
			alias: {
				'@assets': path.join(repoRoot, 'assets'),
			},
		},
		optimizeDeps: {
			include: [
				'react',
				'react/jsx-runtime',
				'react/jsx-dev-runtime',
				'react-dom',
				'react-dom/client',
				'@xyflow/react',
				'lucide-react',
			],
		},
	},
});
