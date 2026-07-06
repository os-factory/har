const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

/** @type {readonly string[]} */
const PACKAGE_PATHS = ['control/package.json', 'packages/schemas/package.json'];

/**
 * Keep Mission Control and shared schemas on the same semver as @osfactory/har.
 * @type {import('semantic-release').PluginSpec}
 */
module.exports = {
  prepare(_pluginConfig, context) {
    const { nextRelease, cwd, logger } = context;

    for (const relPath of PACKAGE_PATHS) {
      const filePath = join(cwd, relPath);
      const pkg = JSON.parse(readFileSync(filePath, 'utf8'));
      pkg.version = nextRelease.version;
      writeFileSync(filePath, `${JSON.stringify(pkg, null, 2)}\n`);
      logger.log(`Synced ${relPath} to v${nextRelease.version}`);
    }
  },
};
