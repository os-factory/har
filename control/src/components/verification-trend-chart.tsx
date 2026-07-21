'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export interface TrendPoint {
  date: string;
  pass: number;
  fail: number;
}

export function VerificationTrendChart({ data }: { data: TrendPoint[] }) {
  if (data.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Verification trend</CardTitle>
          <CardDescription>No verify runs in the selected window.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Verification trend</CardTitle>
        <CardDescription>Pass vs fail by day</CardDescription>
      </CardHeader>
      <CardContent className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
            <XAxis dataKey="date" fontSize={12} />
            <YAxis allowDecimals={false} fontSize={12} />
            <Tooltip />
            <Bar dataKey="pass" stackId="a" fill="hsl(149 42% 64%)" name="pass" />
            <Bar dataKey="fail" stackId="a" fill="hsl(0 84% 60%)" name="fail" />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
