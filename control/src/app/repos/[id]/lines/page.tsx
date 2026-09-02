import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LineBoard } from '@/components/line-board';
import { getRepository } from '@/server/repositories';
import { listLineBoards, repositoryHasHarness } from '@/server/lines';

export const dynamic = 'force-dynamic';

/**
 * Factory line board (#305) — read-only view of the lines installed in a repo.
 *
 * Explainable from `har line status`: same ledger, same program, same run
 * records. Installing a line here is not offered on purpose — that is
 * `har line add` plus the adaptation prompt it writes.
 */
export default async function RepoLinesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const repo = await getRepository(id);
  if (!repo) notFound();

  const [boards, hasHarness] = await Promise.all([
    listLineBoards(id),
    repositoryHasHarness(id),
  ]);
  const repoName = repo.path.split('/').pop() ?? repo.path;

  return (
    <div className="space-y-6 p-6" data-testid="line-board-page">
      <div>
        <h1 className="text-2xl font-semibold">Factory lines</h1>
        <p className="text-sm text-muted-foreground">
          <Link href={`/repos/${id}`} className="underline">
            {repoName}
          </Link>{' '}
          · stations, cumulative gate, and the workstations in use
        </p>
      </div>

      {boards.length === 0 ? (
        <Card data-testid="line-board-empty">
          <CardHeader>
            <CardTitle>No factory line installed</CardTitle>
            <CardDescription>
              {hasHarness
                ? 'This repository has a harness but no line installed.'
                : 'Mission Control has not received a harness for this repository yet. Run har control sync from the repository.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>
              A factory line is a program: an ordered set of stations plus a cumulative gate.
              Installing one adds stages for the gate without changing routine verification.
            </p>
            <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 text-xs">
              <code>
                har line create my-line{'\n'}
                har line add github:os-factory/har-line
              </code>
            </pre>
            <p>
              Lines are installed from the CLI, not from Mission Control — the install writes an
              adaptation prompt for your coding agent.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {boards.map((board) => (
            <LineBoard key={board.id} board={board} />
          ))}
        </div>
      )}
    </div>
  );
}
