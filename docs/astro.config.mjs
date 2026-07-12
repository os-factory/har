// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
	site: 'https://os-factory.github.io',
	base: '/har',
	devToolbar: { enabled: false },
	integrations: [
		starlight({
			title: 'HAR',
			description:
				'The open-source harness and control plane for reproducible AI agent development environments.',
			logo: {
				src: '../logo.png',
				alt: '.har',
			},
			favicon: '/favicon.svg',
			customCss: ['./src/styles/custom.css'],
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
						{ label: 'Introduction', slug: 'getting-started/introduction' },
						{ label: 'Installation', slug: 'getting-started/installation' },
						{ label: 'Quick start', slug: 'getting-started/quick-start' },
						{ label: 'Core concepts', slug: 'getting-started/concepts' },
					],
				},
				{
					label: 'Guides',
					items: [
						{ label: 'Agent workflow', slug: 'guides/agent-workflow' },
						{ label: 'Profiles & configuration', slug: 'guides/profiles' },
						{ label: 'Stages & artifacts', slug: 'guides/stages' },
						{ label: 'Agent integrations', slug: 'guides/agent-integrations' },
						{ label: 'Verification & commit gate', slug: 'guides/verification' },
						{ label: 'Mission Control', slug: 'guides/mission-control' },
						{ label: 'Upgrade a harness', slug: 'guides/upgrading' },
					],
				},
				{
					label: 'Reference',
					items: [
						{ label: 'CLI', slug: 'reference/cli' },
						{ label: 'MCP tools', slug: 'reference/mcp' },
						{ label: 'Harness files', slug: 'reference/harness-files' },
						{ label: 'Environment variables', slug: 'reference/environment' },
					],
				},
				{
					label: 'Project',
					items: [
						{ label: 'Architecture', slug: 'project/architecture' },
						{ label: 'Contributing', slug: 'project/contributing' },
						{ label: 'FAQ', slug: 'project/faq' },
					],
				},
			],
		}),
	],
});
