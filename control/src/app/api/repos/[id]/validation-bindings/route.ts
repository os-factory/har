import { NextResponse } from 'next/server';
import { syncValidationBindings } from '@/server/work-units';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    return NextResponse.json(
      await syncValidationBindings(id, await request.json()),
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
