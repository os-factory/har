import {
  Activity,
  CircleCheckBig,
  FileCode2,
  Globe,
  ScanSearch,
  type LucideIcon,
} from 'lucide-react';
import type { ValidationStageStatus } from '@/server/validation-stages';

export const STAGE_META: Record<string, { title: string; subtitle: string; icon: LucideIcon }> = {
  typecheck: { title: 'Typecheck', subtitle: 'Static analysis', icon: FileCode2 },
  'unit-tests': { title: 'Unit tests', subtitle: 'Vitest suite', icon: CircleCheckBig },
  'api-health': { title: 'API health', subtitle: 'Live endpoint', icon: Activity },
  lint: { title: 'Lint', subtitle: 'ESLint rules', icon: ScanSearch },
  'browser-e2e': { title: 'Browser E2E', subtitle: 'Playwright specs', icon: Globe },
};

export function stageMeta(name: string) {
  return (
    STAGE_META[name] ?? {
      title: name,
      subtitle: 'Verification step',
      icon: CircleCheckBig,
    }
  );
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

export function passRate(stage: ValidationStageStatus): string {
  if (stage.runCount === 0) return '—';
  return `${Math.round((stage.passCount / stage.runCount) * 100)}%`;
}
