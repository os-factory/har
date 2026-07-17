'use client';

import { useMemo, useState } from 'react';
import { type Table } from '@tanstack/react-table';
import { Columns3Icon, SearchIcon, XIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';

interface DataTableToolbarProps<TData> {
  table: Table<TData>;
  searchPlaceholder?: string;
  searchAriaLabel?: string;
}

export function DataTableToolbar<TData>({
  table,
  searchPlaceholder = 'Search…',
  searchAriaLabel = 'Search table',
}: DataTableToolbarProps<TData>) {
  const [columnQuery, setColumnQuery] = useState('');
  const globalFilter = (table.getState().globalFilter as string | undefined) ?? '';

  const hideableColumns = useMemo(
    () => table.getAllColumns().filter((column) => column.getCanHide()),
    [table],
  );

  const filteredColumns = useMemo(() => {
    const q = columnQuery.trim().toLowerCase();
    if (!q) return hideableColumns;
    return hideableColumns.filter((column) => {
      const label = getColumnLabel(column);
      return label.toLowerCase().includes(q) || column.id.toLowerCase().includes(q);
    });
  }, [hideableColumns, columnQuery]);

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="relative max-w-sm flex-1">
        <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          value={globalFilter}
          onChange={(event) => table.setGlobalFilter(event.target.value)}
          placeholder={searchPlaceholder}
          aria-label={searchAriaLabel}
          className="pl-8 pr-8"
        />
        {globalFilter ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-0.5 top-1/2 size-7 -translate-y-1/2 text-muted-foreground"
            onClick={() => table.setGlobalFilter('')}
            aria-label="Clear search"
          >
            <XIcon className="size-3.5" />
          </Button>
        ) : null}
      </div>

      {hideableColumns.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="sm" className="gap-1.5">
              <Columns3Icon className="size-3.5" />
              Columns
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>Toggle columns</DropdownMenuLabel>
            <div className="px-2 pb-2">
              <Input
                type="search"
                value={columnQuery}
                onChange={(event) => setColumnQuery(event.target.value)}
                placeholder="Search columns…"
                aria-label="Search columns"
                className="h-8"
              />
            </div>
            <DropdownMenuSeparator />
            {filteredColumns.length === 0 ? (
              <p className="px-2 py-1.5 text-sm text-muted-foreground">No columns match.</p>
            ) : (
              filteredColumns.map((column) => {
                const label = getColumnLabel(column);
                return (
                  <DropdownMenuCheckboxItem
                    key={column.id}
                    className="capitalize"
                    checked={column.getIsVisible()}
                    onCheckedChange={(value) => column.toggleVisibility(!!value)}
                    onSelect={(event) => event.preventDefault()}
                  >
                    {label}
                  </DropdownMenuCheckboxItem>
                );
              })
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}

function getColumnLabel(column: {
  id: string;
  columnDef: { header?: unknown; meta?: unknown };
}): string {
  const meta = column.columnDef.meta as { label?: string } | undefined;
  if (meta?.label?.trim()) return meta.label;
  if (typeof column.columnDef.header === 'string' && column.columnDef.header.trim()) {
    return column.columnDef.header;
  }
  return column.id.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ');
}
