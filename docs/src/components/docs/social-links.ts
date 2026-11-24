import type { StarlightIcon } from '@astrojs/starlight/types';

/**
 * Header social links — the single source for both Starlight's `social`
 * config (astro.config.mjs) and the SocialIcons override, which can no
 * longer read Starlight's internal `virtual:starlight/user-config` module.
 */
export const socialLinks: { icon: StarlightIcon; label: string; href: string }[] = [
	{ icon: 'github', label: 'GitHub', href: 'https://github.com/os-factory/har' },
];
