import {
  Activity,
  CircleCheckBig,
  FileCode2,
  Globe,
  ScanSearch,
  type LucideIcon,
} from 'lucide-react';
import type { ValidationStageStatus } from '@/server/validation-stages';

/** Icons only: a stage's description always comes from the repository's stages.json, never from its id. */
const STAGE_ICON: Record<string, LucideIcon> = {
  typecheck: FileCode2,
  'api-health': Activity,
  lint: ScanSearch,
  'browser-e2e': Globe,
};

const ACRONYMS: Record<string, string> = { api: 'API', e2e: 'E2E', ui: 'UI', ci: 'CI', css: 'CSS', db: 'DB', mcp: 'MCP' };

/** `unit-tests` → `Unit tests`, `browser-e2e` → `Browser E2E`. */
export function stageTitle(id: string): string {
  const words = id.split(/[-_\s]+/).filter(Boolean);
  if (words.length === 0) return id;
  return words
    .map((word, index) => {
      const acronym = ACRONYMS[word.toLowerCase()];
      if (acronym) return acronym;
      return index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word;
    })
    .join(' ');
}

/** `${NPM_BIN:-npm} test` → `npm test`: shell defaults read as the command a developer would type. */
export function displayCommand(command: string): string {
  return command.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*:-([^}]*)\}/g, '$1').trim();
}

export interface StageDescriptorInput {
  name: string;
  kind?: string | null;
  command?: string | null;
  description?: string | null;
}

/**
 * Title, one-line subtitle and tooltip for a stage, from what the repository's
 * `.har/stages.json` says about it: its kind and command (or script). With no
 * registry entry the subtitle is only the kind — never a guessed tool name.
 */
export function stageMeta(stage: string | StageDescriptorInput): {
  title: string;
  subtitle: string;
  detail: string | null;
  icon: LucideIcon;
} {
  const input: StageDescriptorInput = typeof stage === 'string' ? { name: stage } : stage;
  const command = input.command ? displayCommand(input.command) : null;
  const kind = input.kind ?? null;
  const subtitle = command
    ? kind
      ? `${kind} · ${command}`
      : command
    : kind
      ? `${kind} stage`
      : 'Verification step';
  const detail = [input.description, command].filter(Boolean).join(' — ') || null;
  return {
    title: stageTitle(input.name),
    subtitle,
    detail,
    icon: STAGE_ICON[input.name] ?? CircleCheckBig,
  };
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

export function passRate(stage: ValidationStageStatus): string {
  if (stage.runCount === 0) return '—';
  const pct = Math.round((stage.passCount / stage.runCount) * 100);
  return `${stage.passCount}/${stage.runCount} (${pct}%)`;
}
