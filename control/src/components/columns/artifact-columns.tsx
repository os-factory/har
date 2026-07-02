'use client';

import { type ColumnDef } from '@tanstack/react-table';

export interface ArtifactRow {
  relativePath: string;
  sizeBytes: number;
  modifiedAt: Date | string;
}

export const artifactColumns: ColumnDef<ArtifactRow>[] = [
  {
    accessorKey: 'relativePath',
    header: 'Path',
  },
  {
    accessorKey: 'sizeBytes',
    header: 'Size',
    cell: ({ row }) => `${row.original.sizeBytes} B`,
  },
  {
    accessorKey: 'modifiedAt',
    header: 'Modified',
    cell: ({ row }) => new Date(row.original.modifiedAt).toLocaleString(),
  },
];
