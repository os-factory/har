/** @type {import('semantic-release').GlobalConfig} */
module.exports = {
  branches: ['main'],
  plugins: [
    [
      '@semantic-release/commit-analyzer',
      {
        releaseRules: [
          { scope: 'benchmark', release: false },
          { scope: 'ci', release: false },
          { type: 'docs', release: false },
        ],
      },
    ],
    '@semantic-release/release-notes-generator',
    [
      '@semantic-release/changelog',
      {
        changelogFile: 'CHANGELOG.md',
      },
    ],
    [
      '@semantic-release/exec',
      {
        prepareCmd:
          'npm run build && ./release/prepare-assets.sh ${nextRelease.version}',
      },
    ],
    './release/sync-package-versions.js',
    [
      '@semantic-release/npm',
      {
        // Defer registry publish until Docker Hub succeeds (see release.yml publish-npm).
        npmPublish: false,
      },
    ],
    [
      '@semantic-release/git',
      {
        assets: [
          'CHANGELOG.md',
          'package.json',
          'package-lock.json',
          'control/package.json',
          'packages/schemas/package.json',
        ],
        message:
          'chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}',
      },
    ],
    [
      '@semantic-release/github',
      {
        assets: [
          {
            path: 'release-assets/har-cli-*.tar.gz',
            label: 'HAR CLI bundle (${nextRelease.version})',
          },
          {
            path: 'release-assets/docker-compose.agent-web.yml',
            label: 'Web app docker-compose.agent.yml template',
          },
          {
            path: 'release-assets/docker-compose.agent-cli.yml',
            label: 'CLI profile docker-compose.agent.yml template',
          },
          {
            path: 'release-assets/control-docker-compose.yml',
            label: 'Mission Control docker-compose.yml',
          },
        ],
      },
    ],
  ],
};
