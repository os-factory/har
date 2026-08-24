import * as fs from 'fs';
import * as path from 'path';
import { resolveTemplatesDir } from '../utils/paths';
import { getHarnessDir, resolveHarnessRoot } from '../harness/manifest';
import { resolveAgentEnvFile } from '../core/slot-status';
import { readSlotRegistry } from '../core/slot-registry';
import { detectProcessManager } from './launch';

export interface VerifyPlan {
  /** Bash program that sources the agent env and execs the stage runner. */
  shellCommand: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/**
 * The retired ios verify.sh's xcodebuild target auto-detection, verbatim:
 * explicit workspace/project from harness.env first, else prefer a real
 * .xcworkspace (skipping the one inside every .xcodeproj and Pods/), else
 * the .xcodeproj. Exported so tests can execute the function directly.
 */
export const XC_TARGET_FLAGS_FUNCTION = `xc_target_flags() {
  if [ -n "\${HARNESS_XCODE_WORKSPACE:-}" ] && [ -e "$WORK_DIR/\${HARNESS_XCODE_WORKSPACE}" ]; then
    echo "-workspace $WORK_DIR/\${HARNESS_XCODE_WORKSPACE}"
  elif [ -n "\${HARNESS_XCODE_PROJECT:-}" ] && [ -e "$WORK_DIR/\${HARNESS_XCODE_PROJECT}" ]; then
    echo "-project $WORK_DIR/\${HARNESS_XCODE_PROJECT}"
  else
    local ws prj
    ws="$(cd "$WORK_DIR" && find . -maxdepth 2 -name "*.xcworkspace" \\
      ! -path "./.*" ! -path "*.xcodeproj/*" ! -path "*/Pods/*" 2>/dev/null | head -1 || true)"
    prj="$(cd "$WORK_DIR" && find . -maxdepth 2 -name "*.xcodeproj" \\
      ! -path "./.*" ! -path "*/Pods/*" 2>/dev/null | head -1 || true)"
    if [ -n "$ws" ]; then echo "-workspace $WORK_DIR/\${ws#./}"
    elif [ -n "$prj" ]; then echo "-project $WORK_DIR/\${prj#./}"
    fi
  fi
}
`;

const XC_BLOCK = `
${XC_TARGET_FLAGS_FUNCTION}
XC_FLAGS="$(xc_target_flags)"
export XC_FLAGS
export XC_SCHEME="\${HARNESS_XCODE_SCHEME:-MyApp}"
export XC_DESTINATION="\${HARNESS_IOS_DESTINATION:-platform=iOS Simulator,name=\${HARNESS_SIMULATOR_NAME:-iPhone 16}}"
export XC_DERIVED="\${WORK_DIR}/build/DerivedData"
`;

const API_PORT_BLOCK = `
API_PORT="\${API_PORT:-$(( \${HARNESS_API_BASE_PORT:-8000} + AGENT_ID * 10 ))}"
export API_PORT
`;

/**
 * The #231 stage runner: the harness's installed copy when present, else the
 * package's own (session worktrees don't carry the gitignored .har/lib/).
 */
export function resolveVerifyRunner(harnessDir: string): string {
  const installed = path.join(harnessDir, 'lib', 'verify-runner.mjs');
  if (fs.existsSync(installed)) return installed;
  return path.join(
    resolveTemplatesDir(),
    'runtime-bundles',
    'shared-kernel',
    'lib',
    'verify-runner.mjs',
  );
}

export class VerifyPlanError extends Error {
  constructor(
    message: string,
    public readonly hint: string[],
  ) {
    super(message);
  }
}

/**
 * The verify.sh entry, package-side (#234): resolve the slot's env file and
 * work dir, then exec the #231 stage runner (.har/lib/verify-runner.mjs) with
 * the same exported contract (WORK_DIR, API_PORT, HAR_HARNESS_DIR, XC_* for
 * ios). Stage selection itself stays data in stages.json.
 */
export function buildVerifyPlan(
  repoPath: string,
  agentId: number,
  args: string[],
  baseEnv: NodeJS.ProcessEnv,
): VerifyPlan {
  const repoRoot = resolveHarnessRoot(repoPath);
  const harnessDir = getHarnessDir(repoRoot);
  const pm = detectProcessManager(repoRoot);

  const envFile = resolveAgentEnvFile(repoRoot, agentId);
  if (!envFile) {
    throw new VerifyPlanError(`No .env.agent.${agentId} found.`, [
      `  Launch: har env launch ${agentId}     # or har_launch_environment (MCP)`,
      `  Fallback: ./.har/launch.sh ${agentId}  # when har CLI/MCP unavailable`,
    ]);
  }

  const session = readSlotRegistry(repoRoot, agentId);
  const workDir =
    session?.workDir && session.workDir.length > 0 ? session.workDir : path.dirname(envFile);
  const registryFile = path.join(harnessDir, 'slots', `agent-${agentId}.json`);

  const full = args.includes('--full');
  const banner =
    pm === 'simulator'
      ? `==> Verifying agent ${agentId} in \${WORK_DIR}...`
      : `==> Verifying agent ${agentId} (work dir: \${WORK_DIR})...`;

  const xcBlock = pm === 'simulator' ? XC_BLOCK : API_PORT_BLOCK;

  const shellCommand = `set -euo pipefail
set -a
. ${JSON.stringify(envFile)}
set +a
WORK_DIR=${JSON.stringify(workDir)}
AGENT_ID=${JSON.stringify(String(agentId))}
echo "${banner}" >&2
echo "    Work dir: \${WORK_DIR}" >&2
echo "    Env file: ${envFile}" >&2
if [ -f ${JSON.stringify(registryFile)} ]; then
  echo "    Registry: ${registryFile}" >&2
else
  echo "    Registry: missing (${registryFile})" >&2
fi
export HAR_HARNESS_DIR=${JSON.stringify(harnessDir)}
export WORK_DIR AGENT_ID
${xcBlock}
exec node ${JSON.stringify(resolveVerifyRunner(harnessDir))} --agent ${agentId}${full ? ' --full' : ''}`;

  return {
    shellCommand,
    cwd: repoRoot,
    env: baseEnv,
  };
}
