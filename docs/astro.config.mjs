// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

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

export default defineConfig({
	site: 'https://harproject.dev',
	base: '/',
	devToolbar: { enabled: false },
	redirects,
	integrations: [
		starlight({
			title: 'HAR',
			description:
				'An open-source, agent-agnostic standard for multi-agent coding workflows — parallel agents, deterministic validation, verifiable proof, and observability.',
			logo: {
				src: './public/assets/har-logo.png',
				alt: '.har',
			},
			favicon: '/assets/har-logo.png',
			customCss: ['./src/styles/custom.css'],
			disable404Route: true,
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/os-factory/har' },
			],
			editLink: {
				baseUrl: 'https://github.com/os-factory/har/edit/main/docs/',
			},
			lastUpdated: true,
			sidebar: [
				{ label: 'Website', link: '/' },
				{ label: 'Blog', link: '/blog' },
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
						{ label: 'Profiles & configuration', slug: 'docs/guides/profiles' },
						{ label: 'Stages & artifacts', slug: 'docs/guides/stages' },
						{ label: 'Plugins', slug: 'docs/guides/plugins' },
						{ label: 'Agent integrations', slug: 'docs/guides/agent-integrations' },
						{ label: 'Skill-pack compatibility', slug: 'docs/guides/skill-pack-compatibility' },
						{ label: 'Verification & commit gate', slug: 'docs/guides/verification' },
						{ label: 'Mission Control', slug: 'docs/guides/mission-control' },
						{ label: 'Upgrade a harness', slug: 'docs/guides/upgrading' },
					],
				},
				{
					label: 'Reference',
					items: [
						{ label: 'CLI', slug: 'docs/reference/cli' },
						{ label: 'MCP tools', slug: 'docs/reference/mcp' },
						{ label: 'Harness files', slug: 'docs/reference/harness-files' },
						{ label: 'Environment variables', slug: 'docs/reference/environment' },
					],
				},
				{
					label: 'Project',
					items: [
						{ label: 'Architecture', slug: 'docs/project/architecture' },
						{ label: 'Contributing', slug: 'docs/project/contributing' },
						{ label: 'FAQ', slug: 'docs/project/faq' },
					],
				},
			],
		}),
	],
});
