'use client';

import { useState } from 'react';
import { DataTable } from '@/components/data-table/data-table';
import { ArtifactPreview } from '@/components/artifact-preview';
import { artifactColumns, type ArtifactRow } from '@/components/columns/artifact-columns';

export function ArtifactTable({
  repoId,
  artifacts,
}: {
  repoId: string;
  artifacts: ArtifactRow[];
}) {
  const [selectedArtifact, setSelectedArtifact] = useState<ArtifactRow | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  if (artifacts.length === 0) {
    return <p className="text-sm text-muted-foreground">No artifacts found.</p>;
  }

  const openPreview = (artifact: ArtifactRow) => {
    setSelectedArtifact(artifact);
    setPreviewOpen(true);
  };

  return (
    <>
      <DataTable
        columns={artifactColumns}
        data={artifacts}
        getRowId={(artifact) => artifact.relativePath}
        showPagination={artifacts.length > 10}
        searchPlaceholder="Search artifacts…"
        searchAriaLabel="Search artifacts"
        onRowClick={openPreview}
      />
      <ArtifactPreview
        repoId={repoId}
        artifact={selectedArtifact}
        open={previewOpen}
        onOpenChange={setPreviewOpen}
      />
    </>
  );
}
