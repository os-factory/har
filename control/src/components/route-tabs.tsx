'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Tabs } from '@/components/ui/tabs';

/**
 * Tabs whose active value lives in the URL (`?<param>=<value>`), so a tab can be linked to
 * and survives a reload. Falls back to `defaultValue` when the param is absent or unknown.
 */
export function RouteTabs({
  param = 'tab',
  defaultValue,
  values,
  children,
  className,
}: {
  param?: string;
  defaultValue: string;
  values: string[];
  children: React.ReactNode;
  className?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const requested = searchParams.get(param);
  const value = requested && values.includes(requested) ? requested : defaultValue;

  const onValueChange = (next: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next === defaultValue) params.delete(param);
    else params.set(param, next);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  return (
    <Tabs value={value} onValueChange={onValueChange} className={className}>
      {children}
    </Tabs>
  );
}
