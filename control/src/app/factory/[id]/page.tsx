import { redirect } from 'next/navigation';

/** Work units moved from /factory to /work (Mission Control redesign, phase 1). */
export default async function FactoryRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/work/${id}`);
}
