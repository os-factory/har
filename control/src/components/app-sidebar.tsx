'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { SidebarHealthStrip } from '@/components/sidebar-health-strip';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar';

const navItems = [
  { title: 'Now', url: '/' },
  { title: 'Work', url: '/work' },
  { title: 'Repositories', url: '/repos' },
  { title: 'Cost', url: '/usage' },
  { title: 'Settings', url: '/settings' },
];

function isItemActive(pathname: string, url: string) {
  if (url === '/') return pathname === '/';
  return pathname === url || pathname.startsWith(`${url}/`);
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const pathname = usePathname();
  return (
    <Sidebar {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link href="/">
                <Image
                  src="/logo.png"
                  alt="HAR"
                  width={32}
                  height={32}
                  className="size-8 rounded-lg"
                  priority
                />
                <div className="flex flex-col gap-0.5 leading-none">
                  <span className="font-semibold">Mission Control</span>
                  <span className="text-xs text-muted-foreground">HAR harness</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            {navItems.map((item) => (
              <SidebarMenuItem key={item.title}>
                <SidebarMenuButton asChild isActive={isItemActive(pathname, item.url)}>
                  <Link href={item.url}>{item.title}</Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <div className="space-y-2 p-1">
          <SidebarHealthStrip />
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
