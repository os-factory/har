import { NextResponse } from 'next/server';
import { getCloudBridgeConfig, updateCloudBridgeConfig } from '@/server/cloud-bridge';

export async function GET() {
  const config = await getCloudBridgeConfig();
  return NextResponse.json(config);
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const config = await updateCloudBridgeConfig(body);
    return NextResponse.json(config);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
