import {
  Activity,
  Box,
  CircleCheckBig,
  FileCode2,
  Globe,
  ScanSearch,
  type LucideIcon,
} from 'lucide-react';

/** Demo verification stages from control/.har — mirrors Mission Control's pipeline. */
export interface HeroStage {
  id: string;
  title: string;
  subtitle: string;
  icon: LucideIcon;
  durationMs: number;
  status: 'pass' | 'fail';
}

export const HERO_VERIFICATION_STAGES: HeroStage[] = [
  { id: 'typecheck', title: 'Typecheck', subtitle: 'Static analysis', icon: FileCode2, durationMs: 2100, status: 'pass' },
  { id: 'unit-tests', title: 'Unit tests', subtitle: 'Vitest suite', icon: CircleCheckBig, durationMs: 8400, status: 'pass' },
  { id: 'api-health', title: 'API health', subtitle: 'Live endpoint', icon: Activity, durationMs: 1200, status: 'pass' },
  { id: 'lint', title: 'Lint', subtitle: 'ESLint rules', icon: ScanSearch, durationMs: 4800, status: 'pass' },
  { id: 'browser-e2e', title: 'Browser E2E', subtitle: 'Playwright specs', icon: Globe, durationMs: 41200, status: 'pass' },
  { id: 'docker-build', title: 'Docker build', subtitle: 'Image smoke-boot', icon: Box, durationMs: 12500, status: 'pass' },
];

export function formatStageDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}
