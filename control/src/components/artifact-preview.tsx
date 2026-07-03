'use client';

import { useEffect, useState } from 'react';
import { Download, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  artifactFileUrl,
  formatArtifactSize,
  getArtifactPreviewKind,
  MAX_TEXT_PREVIEW_BYTES,
  type ArtifactPreviewKind,
} from '@/lib/artifact-preview';
import type { ArtifactRow } from '@/components/columns/artifact-columns';

interface ArtifactPreviewProps {
  repoId: string;
  artifact: ArtifactRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function PreviewBody({
  repoId,
  artifact,
  kind,
}: {
  repoId: string;
  artifact: ArtifactRow;
  kind: ArtifactPreviewKind;
}) {
  const url = artifactFileUrl(repoId, artifact.relativePath);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [textError, setTextError] = useState<string | null>(null);
  const [loadingText, setLoadingText] = useState(kind === 'text');

  useEffect(() => {
    if (kind !== 'text') {
      setTextContent(null);
      setTextError(null);
      setLoadingText(false);
      return;
    }

    if (artifact.sizeBytes > MAX_TEXT_PREVIEW_BYTES) {
      setTextContent(null);
      setTextError(
        `File is too large to preview (${formatArtifactSize(artifact.sizeBytes)}). Download it instead.`,
      );
      setLoadingText(false);
      return;
    }

    let cancelled = false;
    setLoadingText(true);
    setTextContent(null);
    setTextError(null);

    fetch(url)
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load artifact (${res.status})`);
        const raw = await res.text();
        if (cancelled) return;

        const ext = artifact.relativePath.split('.').pop()?.toLowerCase();
        if (ext === 'json') {
          try {
            setTextContent(JSON.stringify(JSON.parse(raw), null, 2));
          } catch {
            setTextContent(raw);
          }
        } else {
          setTextContent(raw);
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setTextError(error instanceof Error ? error.message : 'Failed to load artifact');
      })
      .finally(() => {
        if (!cancelled) setLoadingText(false);
      });

    return () => {
      cancelled = true;
    };
  }, [artifact.relativePath, artifact.sizeBytes, kind, url]);

  switch (kind) {
    case 'image':
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-md border bg-muted/30 p-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url}
            alt={artifact.relativePath}
            className="max-h-[70vh] max-w-full object-contain"
          />
        </div>
      );
    case 'video':
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-md border bg-muted/30 p-4">
          <video src={url} controls className="max-h-[70vh] max-w-full">
            <track kind="captions" />
          </video>
        </div>
      );
    case 'audio':
      return (
        <div className="rounded-md border bg-muted/30 p-6">
          <audio src={url} controls className="w-full">
            <track kind="captions" />
          </audio>
        </div>
      );
    case 'html':
    case 'pdf':
      return (
        <iframe
          src={url}
          title={artifact.relativePath}
          className="min-h-[70vh] w-full flex-1 rounded-md border bg-background"
        />
      );
    case 'text':
      if (loadingText) {
        return <p className="text-sm text-muted-foreground">Loading preview…</p>;
      }
      if (textError) {
        return <p className="text-sm text-destructive">{textError}</p>;
      }
      return (
        <pre className="max-h-[70vh] overflow-auto rounded-md border bg-muted/30 p-4 text-xs leading-relaxed">
          <code>{textContent}</code>
        </pre>
      );
    default:
      return (
        <div className="rounded-md border bg-muted/30 p-6 text-sm text-muted-foreground">
          Preview is not available for this file type. Use download to open it locally.
        </div>
      );
  }
}

export function ArtifactPreview({ repoId, artifact, open, onOpenChange }: ArtifactPreviewProps) {
  const kind = artifact ? getArtifactPreviewKind(artifact.relativePath) : 'binary';
  const url = artifact ? artifactFileUrl(repoId, artifact.relativePath) : '';

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col sm:max-w-3xl">
        {artifact && (
          <>
            <SheetHeader>
              <SheetTitle className="break-all pr-8 font-mono text-base">{artifact.relativePath}</SheetTitle>
              <SheetDescription>
                {formatArtifactSize(artifact.sizeBytes)} · modified{' '}
                {new Date(artifact.modifiedAt).toLocaleString()}
              </SheetDescription>
            </SheetHeader>

            <div className="flex shrink-0 gap-2">
              <Button asChild size="sm" variant="outline">
                <a href={url} download>
                  <Download className="mr-2 h-4 w-4" />
                  Download
                </a>
              </Button>
              {(kind === 'html' || kind === 'pdf' || kind === 'image') && (
                <Button asChild size="sm" variant="outline">
                  <a href={url} target="_blank" rel="noreferrer">
                    <ExternalLink className="mr-2 h-4 w-4" />
                    Open in tab
                  </a>
                </Button>
              )}
            </div>

            <div className="flex min-h-0 flex-1 flex-col overflow-hidden pt-2">
              <PreviewBody repoId={repoId} artifact={artifact} kind={kind} />
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
