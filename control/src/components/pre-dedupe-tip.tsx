'use client';

import type { ReactNode } from 'react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { PRE_DEDUPE_USAGE_HINT } from '@/lib/usage-models';

/**
 * The one hover treatment for a figure harvested before the token-dedupe fix:
 * a marker that explains itself. A real button so it is keyboard-reachable —
 * a bare `title` is neither discoverable nor focusable.
 */
export function PreDedupeTip({ children }: { children?: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="Why this figure reads high"
          className="cursor-help underline decoration-dotted underline-offset-2"
        >
          {children ?? '≈'}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-pretty">
        {PRE_DEDUPE_USAGE_HINT}
      </TooltipContent>
    </Tooltip>
  );
}
