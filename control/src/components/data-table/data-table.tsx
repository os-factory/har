'use client';

import {
  useEffect,
  useId,
  useMemo,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import {
  type ColumnDef,
  type ColumnFiltersState,
  type FilterFn,
  type OnChangeFn,
  type RowSelectionState,
  type SortingState,
  type VisibilityState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type Table as TanstackTable,
} from '@tanstack/react-table';

import { Checkbox } from '@/components/ui/checkbox';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

import { DataTableColumnHeader } from './data-table-column-header';
import { DataTablePagination } from './data-table-pagination';
import { DataTableToolbar } from './data-table-toolbar';

const defaultGlobalFilterFn: FilterFn<unknown> = (row, _columnId, filterValue) => {
  const q = String(filterValue ?? '')
    .trim()
    .toLowerCase();
  if (!q) return true;

  const visit = (value: unknown): boolean => {
    if (value == null) return false;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return String(value).toLowerCase().includes(q);
    }
    if (value instanceof Date) {
      return value.toISOString().toLowerCase().includes(q) || value.toLocaleString().toLowerCase().includes(q);
    }
    if (Array.isArray(value)) {
      return value.some(visit);
    }
    if (typeof value === 'object') {
      return Object.values(value as Record<string, unknown>).some(visit);
    }
    return false;
  };

  return visit(row.original);
};

function withSortableHeaders<TData, TValue>(
  columns: ColumnDef<TData, TValue>[],
): ColumnDef<TData, TValue>[] {
  return columns.map((column) => {
    if (typeof column.header !== 'string') return column;

    const title = column.header;
    const hasAccessor = 'accessorKey' in column || 'accessorFn' in column;
    const enableSorting = column.enableSorting ?? hasAccessor;
    const meta = {
      ...(typeof column.meta === 'object' && column.meta !== null ? column.meta : {}),
      label: title,
    };

    if (!enableSorting) {
      return { ...column, enableSorting: false, meta } as ColumnDef<TData, TValue>;
    }

    return {
      ...column,
      enableSorting: true,
      meta,
      header: ({ column: col }) => <DataTableColumnHeader column={col} title={title} />,
    } as ColumnDef<TData, TValue>;
  });
}

function selectionColumn<TData>(): ColumnDef<TData, unknown> {
  return {
    id: 'select',
    enableSorting: false,
    enableHiding: false,
    header: ({ table }) => (
      <div data-row-click-ignore className="px-1" onClick={(event) => event.stopPropagation()}>
        <Checkbox
          aria-label="Select all rows"
          checked={
            table.getIsAllPageRowsSelected() ||
            (table.getIsSomePageRowsSelected() && 'indeterminate')
          }
          onCheckedChange={(value) => table.toggleAllPageRowsSelected(value === true)}
        />
      </div>
    ),
    cell: ({ row }) => (
      <div data-row-click-ignore className="px-1" onClick={(event) => event.stopPropagation()}>
        <Checkbox
          aria-label={`Select row ${row.id}`}
          checked={row.getIsSelected()}
          onCheckedChange={(value) => row.toggleSelected(value === true)}
        />
      </div>
    ),
  };
}

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  table?: TanstackTable<TData>;
  showPagination?: boolean;
  showToolbar?: boolean;
  searchPlaceholder?: string;
  searchAriaLabel?: string;
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
  enableRowSelection?: boolean;
  rowSelection?: RowSelectionState;
  onRowSelectionChange?: OnChangeFn<RowSelectionState>;
  toolbarExtra?: ReactNode;
}

export function DataTable<TData, TValue>({
  columns,
  data,
  table: externalTable,
  showPagination = true,
  showToolbar = true,
  searchPlaceholder,
  searchAriaLabel,
  pageSize = 10,
  getRowId,
  emptyMessage = 'No results.',
  globalFilter: controlledGlobalFilter,
  onGlobalFilterChange,
  globalFilterFn,
  columnFilters: controlledColumnFilters,
  onColumnFiltersChange,
  columnVisibility: controlledColumnVisibility,
  onRowClick,
  getRowClassName,
  enableRowSelection = false,
  rowSelection: controlledRowSelection,
  onRowSelectionChange,
  toolbarExtra,
}: DataTableProps<TData, TValue>) {
  const paginationId = useId();
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize });
  const [sorting, setSorting] = useState<SortingState>([]);
  const [internalGlobalFilter, setInternalGlobalFilter] = useState('');
  const [internalColumnFilters, setInternalColumnFilters] = useState<ColumnFiltersState>([]);
  const [internalColumnVisibility, setInternalColumnVisibility] = useState<VisibilityState>({});
  const [internalRowSelection, setInternalRowSelection] = useState<RowSelectionState>({});

  const globalFilter = controlledGlobalFilter ?? internalGlobalFilter;
  const setGlobalFilter = onGlobalFilterChange ?? setInternalGlobalFilter;
  const columnFilters = controlledColumnFilters ?? internalColumnFilters;
  const setColumnFilters = onColumnFiltersChange ?? setInternalColumnFilters;
  const rowSelection = controlledRowSelection ?? internalRowSelection;
  const setRowSelection = onRowSelectionChange ?? setInternalRowSelection;
  const columnVisibility = {
    ...internalColumnVisibility,
    ...controlledColumnVisibility,
  };

  const enhancedColumns = useMemo(() => {
    const sortable = withSortableHeaders(columns);
    if (!enableRowSelection) return sortable;
    return [selectionColumn<TData>(), ...sortable] as ColumnDef<TData, TValue>[];
  }, [columns, enableRowSelection]);

  const internalTable = useReactTable({
    data,
    columns: enhancedColumns,
    getRowId,
    enableRowSelection,
    state: {
      sorting,
      globalFilter,
      columnFilters,
      columnVisibility,
      ...(enableRowSelection ? { rowSelection } : {}),
      ...(showPagination ? { pagination } : {}),
    },
    onSortingChange: setSorting,
    onPaginationChange: showPagination ? setPagination : undefined,
    onGlobalFilterChange: setGlobalFilter,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setInternalColumnVisibility,
    onRowSelectionChange: enableRowSelection ? setRowSelection : undefined,
    globalFilterFn: (globalFilterFn ?? defaultGlobalFilterFn) as FilterFn<TData>,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: showPagination ? getPaginationRowModel() : undefined,
  });

  const table = externalTable ?? internalTable;

  useEffect(() => {
    if (showPagination && !externalTable) {
      setPagination((current) => ({ ...current, pageIndex: 0 }));
    }
  }, [globalFilter, columnFilters, showPagination, externalTable]);

  const handleRowClick = (event: MouseEvent, row: TData) => {
    if (!onRowClick) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('a, button, input, textarea, select, [role="menuitem"], [data-row-click-ignore]')) {
      return;
    }
    onRowClick(row);
  };

  const handleRowKeyDown = (event: KeyboardEvent, row: TData) => {
    if (!onRowClick) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const target = event.target as HTMLElement | null;
    if (target && target !== event.currentTarget) return;
    event.preventDefault();
    onRowClick(row);
  };

  return (
    <div className="min-w-0 space-y-4">
      {showToolbar || toolbarExtra ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          {showToolbar ? (
            <DataTableToolbar
              table={table}
              searchPlaceholder={searchPlaceholder}
              searchAriaLabel={searchAriaLabel}
            />
          ) : (
            <div />
          )}
          {toolbarExtra}
        </div>
      ) : null}
      <div className="min-w-0 overflow-x-auto rounded-md border">
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
                  className={cn(
                    getRowClassName?.(row.original),
                    onRowClick && 'cursor-pointer',
                  )}
                  onClick={onRowClick ? (event) => handleRowClick(event, row.original) : undefined}
                  onKeyDown={onRowClick ? (event) => handleRowKeyDown(event, row.original) : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
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
