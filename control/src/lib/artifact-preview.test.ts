import { describe, expect, it } from 'vitest';
import {
  artifactFileUrl,
  getArtifactContentType,
  getArtifactPreviewKind,
} from '@/lib/artifact-preview';

describe('artifact preview helpers', () => {
  it('classifies common artifact types', () => {
    expect(getArtifactPreviewKind('.har/artifacts/screenshot.png')).toBe('image');
    expect(getArtifactPreviewKind('.har/artifacts/trace.webm')).toBe('video');
    expect(getArtifactPreviewKind('.har/artifacts/error-context.md')).toBe('text');
    expect(getArtifactPreviewKind('.har/artifacts/browser-e2e/playwright-report/index.html')).toBe(
      'html',
    );
    expect(getArtifactPreviewKind('.har/artifacts/report.pdf')).toBe('pdf');
    expect(getArtifactPreviewKind('.har/artifacts/archive.zip')).toBe('binary');
  });

  it('maps content types for previewable files', () => {
    expect(getArtifactContentType('.har/artifacts/screenshot.png')).toBe('image/png');
    expect(getArtifactContentType('.har/artifacts/trace.webm')).toBe('video/webm');
    expect(getArtifactContentType('.har/artifacts/error-context.md')).toBe(
      'text/markdown; charset=utf-8',
    );
  });

  it('builds artifact download URLs', () => {
    expect(artifactFileUrl('repo-1', '.har/artifacts/foo bar.png')).toBe(
      '/api/repos/repo-1/artifacts?file=.har%2Fartifacts%2Ffoo%20bar.png',
    );
  });
});
