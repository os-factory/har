'use client';

import { useEffect, useId, useState } from 'react';
import {
  type ColumnDef,
  type ColumnFiltersState,
  type FilterFn,
  type OnChangeFn,
  type VisibilityState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  useReactTable,
  type Table as TanstackTable,
} from '@tanstack/react-table';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

import { DataTablePagination } from './data-table-pagination';

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  table?: TanstackTable<TData>;
  showPagination?: boolean;
  pageSize?: number;
  getRowId?: (row: TData) => string;
  emptyMessage?: string;
  globalFilter?: string;
  onGlobalFilterChange?: (value: string) => void;
  globalFilterFn?: FilterFn<TData>;
  columnFilters?: ColumnFiltersState;
  onColumnFiltersChange?: OnChangeFn<ColumnFiltersState>;
  columnVisibility?: VisibilityState;
  onRowClick?: (row: TData) => void;
  getRowClassName?: (row: TData) => string | undefined;
}

export function DataTable<TData, TValue>({
  columns,
  data,
  table: externalTable,
  showPagination = true,
  pageSize = 10,
  getRowId,
  emptyMessage = 'No results.',
  globalFilter,
  onGlobalFilterChange,
  globalFilterFn,
  columnFilters,
  onColumnFiltersChange,
  columnVisibility,
  onRowClick,
  getRowClassName,
}: DataTableProps<TData, TValue>) {
  const paginationId = useId();
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize });
  const usesFiltering =
    globalFilter !== undefined ||
    columnFilters !== undefined ||
    globalFilterFn !== undefined;

  const internalTable = useReactTable({
    data,
    columns,
    getRowId,
    state: {
      ...(showPagination ? { pagination } : {}),
      ...(globalFilter !== undefined ? { globalFilter } : {}),
      ...(columnFilters !== undefined ? { columnFilters } : {}),
      ...(columnVisibility !== undefined ? { columnVisibility } : {}),
    },
    onPaginationChange: showPagination ? setPagination : undefined,
    onGlobalFilterChange,
    onColumnFiltersChange,
    globalFilterFn,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: usesFiltering ? getFilteredRowModel() : undefined,
    getPaginationRowModel: showPagination ? getPaginationRowModel() : undefined,
  });

  const table = externalTable ?? internalTable;

  useEffect(() => {
    if (showPagination && !externalTable) {
      setPagination((current) => ({ ...current, pageIndex: 0 }));
    }
  }, [globalFilter, columnFilters, showPagination, externalTable]);

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() && 'selected'}
                  className={getRowClassName?.(row.original)}
                  onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center">
                  {emptyMessage}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {showPagination && <DataTablePagination table={table} rowsPerPageId={paginationId} />}
    </div>
  );
}
