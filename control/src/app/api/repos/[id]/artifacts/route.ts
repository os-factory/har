import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { listArtifactFiles, readArtifactFile } from '@/server/artifacts';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(request.url);
  const file = url.searchParams.get('file');

  const repo = await prisma.repository.findUnique({ where: { id } });
  if (!repo) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  if (file) {
    const content = readArtifactFile(repo.path, file);
    if (!content) return NextResponse.json({ error: 'Artifact not found' }, { status: 404 });
    return new NextResponse(new Uint8Array(content), {
      headers: { 'Content-Type': 'application/octet-stream' },
    });
  }

  const artifacts = listArtifactFiles(repo.path);
  return NextResponse.json({ artifacts });
}
