/**
 * PM2 ecosystem for Mission Control (Next.js) per agent slot.
 * Ports are allocated at launch and written to .env.agent.<id>.
 */

// launch.sh writes this file (and .env.agent.N) into the work dir — the
// control/ project dir (repo root checkout or inside the agent's worktree) —
// so __dirname IS the Next.js app directory.
const path = require('path');
const dotenv = require('dotenv');

const agentEnvPath = path.resolve(__dirname, '.env.agent.${AGENT_ID}');
const env = dotenv.config({ path: agentEnvPath }).parsed || {};
const port = env.FE_PORT || env.PORT || '3847';

module.exports = {
  apps: [
    {
      name: 'har-${HARNESS_PROJECT_NAME}-agent-${AGENT_ID}-web',
      script: 'npx',
      args: `next dev --port ${port}`,
      interpreter: 'none',
      cwd: __dirname,
      env: {
        ...env,
        NODE_ENV: 'development',
        PORT: port,
      },
      watch: false,
      autorestart: true,
      kill_timeout: 5000,
      merge_logs: true,
      time: true,
    },
  ],
};
