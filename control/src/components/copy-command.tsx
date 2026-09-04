'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * One exact shell command with a copy button (#340). Mission Control cannot run
 * `har` itself — it may be in a container — so the next step is always a command the
 * developer pastes into their own terminal.
 */
export function CopyCommand({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable: the command is selectable text */
    }
  };
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md border bg-muted/30 px-2 py-1.5" data-testid="copy-command">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <code className="min-w-0 flex-1 truncate font-mono text-xs" title={command}>
        {command}
      </code>
      <Button variant="ghost" size="sm" className="h-6 px-1.5" onClick={() => void copy()} aria-label={`Copy: ${command}`}>
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </Button>
    </div>
  );
}
