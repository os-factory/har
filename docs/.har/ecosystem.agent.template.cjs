/**
 * PM2 ecosystem for the Astro docs / marketing site (primary app only).
 * Ports are allocated at launch and written to .env.agent.<id>.
 *
 * launch.sh envsubst-replaces ${AGENT_ID}, ${HARNESS_PROJECT_NAME}, ${FE_PORT}.
 */

module.exports = {
  apps: [
    {
      name: 'har-${HARNESS_PROJECT_NAME}-agent-${AGENT_ID}-web',
      script: 'npx',
      args: 'astro dev --port ${FE_PORT} --host 127.0.0.1',
      interpreter: 'none',
      cwd: __dirname,
      env: {
        NODE_ENV: 'development',
        PORT: '${FE_PORT}',
        HOST: '127.0.0.1',
      },
      watch: false,
      autorestart: true,
      kill_timeout: 5000,
      merge_logs: true,
      time: true,
    },
  ],
};
