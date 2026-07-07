import { getHarPackageVersion } from './package-version';

export const DEFAULT_CONTROL_IMAGE = 'theosfactory/har-control';

/** Docker image repository for Mission Control (without tag). */
export function getControlImageName(): string {
  return process.env.HAR_CONTROL_IMAGE ?? DEFAULT_CONTROL_IMAGE;
}

/** Image tag — defaults to the installed CLI version so releases stay coupled. */
export function getControlImageTag(): string {
  return process.env.HAR_CONTROL_IMAGE_TAG ?? getHarPackageVersion();
}

export function getControlImageRef(): string {
  return `${getControlImageName()}:${getControlImageTag()}`;
}

export function shouldBuildControlLocally(): boolean {
  return process.env.HAR_CONTROL_BUILD === 'true';
}
