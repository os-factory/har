import { getControlApiUrl, isControlEnabled } from './control-config';
import { startMissionControl } from './control-lifecycle';
import { isControlApiReachable, waitForControlApi } from './control-sync';
import { isTelemetryEnabled } from './telemetry-config';

export interface EnsureTelemetryResult {
  telemetryEnabled: boolean;
  controlEnabled: boolean;
  apiUrl: string;
  reachable: boolean;
  started: boolean;
  otelReady: boolean;
  message?: string;
  warning?: string;
}

/**
 * When telemetry is on, ensure Mission Control is reachable so agents can export OTLP.
 * Does not start MC when telemetry is off.
 */
export async function ensureTelemetryInfrastructure(options?: {
  startIfNeeded?: boolean;
}): Promise<EnsureTelemetryResult> {
  const apiUrl = getControlApiUrl();
  const telemetryEnabled = isTelemetryEnabled();
  const controlEnabled = isControlEnabled();
  const startIfNeeded = options?.startIfNeeded !== false;

  if (!telemetryEnabled) {
    return {
      telemetryEnabled: false,
      controlEnabled,
      apiUrl,
      reachable: false,
      started: false,
      otelReady: false,
      message: 'Telemetry is off — Mission Control will not be auto-started. Enable with: har telemetry on',
    };
  }

  if (!controlEnabled) {
    return {
      telemetryEnabled: true,
      controlEnabled: false,
      apiUrl,
      reachable: false,
      started: false,
      otelReady: false,
      warning:
        'Telemetry is on but HAR_CONTROL_DISABLED=true — cannot start Mission Control. Unset it or run har control up manually.',
    };
  }

  if (await isControlApiReachable(apiUrl)) {
    return {
      telemetryEnabled: true,
      controlEnabled: true,
      apiUrl,
      reachable: true,
      started: false,
      otelReady: true,
      message: `Telemetry on — Mission Control reachable at ${apiUrl}`,
    };
  }

  if (!startIfNeeded || process.env.NODE_ENV === 'test') {
    return {
      telemetryEnabled: true,
      controlEnabled: true,
      apiUrl,
      reachable: false,
      started: false,
      otelReady: false,
      warning: `Telemetry on but Mission Control is not reachable at ${apiUrl}. Run: har control up`,
    };
  }

  try {
    const { code } = await startMissionControl({ detach: true });
    if (code !== 0) {
      return {
        telemetryEnabled: true,
        controlEnabled: true,
        apiUrl,
        reachable: false,
        started: false,
        otelReady: false,
        warning: `Telemetry on — failed to start Mission Control (exit ${code}). OTEL export skipped; harvest may fill gaps later. Fix Docker / run: har control up`,
      };
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      telemetryEnabled: true,
      controlEnabled: true,
      apiUrl,
      reachable: false,
      started: false,
      otelReady: false,
      warning: `Telemetry on — could not start Mission Control (${detail}). OTEL export skipped. Run: har control up`,
    };
  }

  const ready = await waitForControlApi(apiUrl, 90_000);
  if (!ready) {
    return {
      telemetryEnabled: true,
      controlEnabled: true,
      apiUrl,
      reachable: false,
      started: true,
      otelReady: false,
      warning: `Telemetry on — started Mission Control but API did not become ready at ${apiUrl}. OTEL export skipped for now.`,
    };
  }

  return {
    telemetryEnabled: true,
    controlEnabled: true,
    apiUrl,
    reachable: true,
    started: true,
    otelReady: true,
    message: `Telemetry on — started Mission Control at ${apiUrl}`,
  };
}
