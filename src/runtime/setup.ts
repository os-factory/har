import { readHarnessEnv } from '../harness/env';
import { getHarnessDir, resolveHarnessRoot } from '../harness/manifest';
import { defaultExec, ExecFn, LogFn, SleepFn, stderrLog } from './exec';
import { setupInfra } from './infra';
import { detectProcessManager } from './launch';
import {
  deviceByName,
  deviceField,
  perSlotEnabled,
  planCreation,
  preferredFamily,
  Simctl,
} from './xcode-sim';

export interface SetupInfraRunOptions {
  repoPath: string;
  exec?: ExecFn;
  log?: LogFn;
  sleep?: SleepFn;
  portInUse?: (port: number) => boolean;
  simctl?: Simctl;
}

export interface SetupInfraRunResult {
  code: number;
}

/**
 * setup-infra with the profile split the three generated scripts used to fork:
 * docker/pg infra for pm2 and cli harnesses (template-DB flow only for pm2),
 * Xcode/simulator readiness for ios harnesses (plus optional docker services).
 */
export async function runSetupInfra(options: SetupInfraRunOptions): Promise<SetupInfraRunResult> {
  const repoRoot = resolveHarnessRoot(options.repoPath);
  const harnessDir = getHarnessDir(repoRoot);
  const env = readHarnessEnv(repoRoot);
  const pm = detectProcessManager(repoRoot);
  const log = options.log ?? stderrLog;
  const exec = options.exec ?? defaultExec;

  if (pm === 'simulator') {
    return runIosSetupInfra({ env, harnessDir, exec, log, simctl: options.simctl });
  }

  try {
    await setupInfra({
      harnessDir,
      repoRoot,
      env,
      templateDbFlow: pm === 'pm2',
      exec,
      log,
      sleep: options.sleep,
      portInUse: options.portInUse,
    });
    return { code: 0 };
  } catch (err) {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    return { code: 1 };
  }
}

/** The ios setup-infra.sh flow: Xcode check, simulator readiness, optional compose. */
function runIosSetupInfra(ctx: {
  env: Record<string, string>;
  harnessDir: string;
  exec: ExecFn;
  log: LogFn;
  simctl?: Simctl;
}): SetupInfraRunResult {
  const { env, harnessDir, exec, log } = ctx;
  const err = (message: string) => process.stderr.write(`${message}\n`);

  const xcodebuild = exec('xcodebuild', ['-version']);
  if (xcodebuild.code !== 0) {
    err('Error: xcodebuild not found — install Xcode from the App Store.');
    return { code: 1 };
  }
  log(`Found: ${xcodebuild.stdout.split('\n')[0] || 'Xcode (unknown)'}`);

  const simulatorName = env.HARNESS_SIMULATOR_NAME ?? 'iPhone 16';
  const simctl = ctx.simctl ?? new Simctl();

  let sharedUdid = '';
  if (perSlotEnabled(env)) {
    const family = preferredFamily(env);
    const plan = planCreation(simctl, env.HARNESS_SIMULATOR_NAME ?? '', family);
    if (plan.status === 'OK') {
      log(`Per-slot simulators: launch creates one ${plan.deviceTypeName} per agent.`);
    } else if (plan.status === 'SIMCTL_UNAVAILABLE') {
      simctl.logUnavailable();
      return { code: 1 };
    } else if (
      plan.status === 'NO_MODEL' &&
      deviceByName(simctl, env.HARNESS_SIMULATOR_NAME ?? '')
    ) {
      log(`Per-slot simulators: launch reuses the existing device '${simulatorName}'.`);
    } else {
      err(`Error: no simulator can be prepared for '${simulatorName}'.`);
      if ('models' in plan && plan.models) {
        err(`  Available ${family} models: ${plan.models}`);
      } else {
        err('  No iOS runtime is installed — add one in Xcode → Settings → Components.');
      }
      err('  Update HARNESS_SIMULATOR_NAME in .har/harness.env.');
      return { code: 1 };
    }
  } else {
    log(`Checking simulator: ${simulatorName}`);
    const udid = deviceByName(simctl, simulatorName);
    if (!udid) {
      if (!simctl.available()) {
        simctl.logUnavailable();
        return { code: 1 };
      }
      err(`Error: Simulator '${simulatorName}' not found in available devices.`);
      err('  Update HARNESS_SIMULATOR_NAME in .har/harness.env.');
      return { code: 1 };
    }
    sharedUdid = udid;
    if (deviceField(simctl, udid, 'state') === 'Booted') {
      log(`Simulator '${simulatorName}' (${udid}) is already booted.`);
    } else {
      log(`Booting simulator '${simulatorName}' (${udid})...`);
      if (simctl.tryCall(['boot', udid]) || simctl.tryCall(['bootstatus', udid, '-b'])) {
        log('Simulator is ready.');
      } else {
        err('Warning: Simulator did not reach Booted state.');
      }
    }
  }

  const services = (env.HARNESS_INFRA_SERVICES ?? '').trim();
  if (services) {
    const composeProject = `har-${env.HARNESS_PROJECT_NAME ?? ''}`;
    log(`Starting shared infrastructure (project: ${composeProject}): ${services}`);
    const compose = exec('docker', [
      'compose', '-p', composeProject,
      '-f', `${harnessDir}/docker-compose.agent.yml`,
      'up', '-d', ...services.split(/\s+/),
    ]);
    if (compose.code !== 0) return { code: compose.code };
  }

  log('');
  log('Infrastructure is ready.');
  if (sharedUdid) log(`  Simulator: ${simulatorName} (${sharedUdid})`);
  return { code: 0 };
}
