'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';

async function writeClipboard(command: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(command);
    return true;
  } catch {
    /* clipboard unavailable: the command is selectable text */
    return false;
  }
}

/**
 * One exact shell command with a copy button (#340). Mission Control cannot run
 * `har` itself — it may be in a container — so the next step is always a command the
 * developer pastes into their own terminal.
 */
export function CopyCommand({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!(await writeClipboard(command))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
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

/**
 * Compact label-only copy buttons for table cells (#340). The full command lives
 * in the title and accessible name so a row stays one line.
 */
export function CopyCommandButtons({ commands }: { commands: Array<{ label: string; command: string }> }) {
  const [copied, setCopied] = useState<string | null>(null);
  if (commands.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap gap-1" data-testid="slot-commands">
      {commands.map((entry) => (
        <Button
          key={entry.label}
          type="button"
          variant="outline"
          size="sm"
          className="h-6 px-2 text-xs"
          title={entry.command}
          aria-label={`Copy: ${entry.command}`}
          onClick={() => {
            void writeClipboard(entry.command).then((ok) => {
              if (!ok) return;
              setCopied(entry.command);
              setTimeout(() => setCopied((current) => (current === entry.command ? null : current)), 1500);
            });
          }}
        >
          {copied === entry.command ? <Check className="size-3" /> : null}
          {entry.label}
        </Button>
      ))}
    </div>
  );
}
