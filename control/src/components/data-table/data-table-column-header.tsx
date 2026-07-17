'use client';

import { type HTMLAttributes } from 'react';
import { type Column } from '@tanstack/react-table';
import { ArrowDownIcon, ArrowUpIcon, ChevronsUpDownIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

interface DataTableColumnHeaderProps<TData, TValue> extends HTMLAttributes<HTMLDivElement> {
  column: Column<TData, TValue>;
  title: string;
}

export function DataTableColumnHeader<TData, TValue>({
  column,
  title,
  className,
}: DataTableColumnHeaderProps<TData, TValue>) {
  if (!column.getCanSort()) {
    return <div className={cn(className)}>{title}</div>;
  }

  const sorted = column.getIsSorted();

  return (
    <div className={cn('flex items-center gap-1', className)}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="-ml-3 h-8 gap-1.5 px-2 text-foreground hover:bg-accent data-[state=open]:bg-accent"
        onClick={() => column.toggleSorting(sorted === 'asc')}
      >
        <span>{title}</span>
        {sorted === 'desc' ? (
          <ArrowDownIcon className="size-3.5 opacity-70" />
        ) : sorted === 'asc' ? (
          <ArrowUpIcon className="size-3.5 opacity-70" />
        ) : (
          <ChevronsUpDownIcon className="size-3.5 opacity-70" />
        )}
      </Button>
    </div>
  );
}
