import { AgentToolSchema } from '@har/schemas';
import type { AgentTrajectoryRecord } from '@prisma/client';
import {
  cursorForTrajectory,
  decodeTrajectoryCursor,
  listTrajectoryAfter,
  subscribeToTrajectory,
  type TrajectoryScope,
} from '@/server/trajectory-ledger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const encoder = new TextEncoder();

function trajectoryMessage(record: Awaited<ReturnType<typeof listTrajectoryAfter>>[number]): Uint8Array {
  const cursor = cursorForTrajectory(record);
  return encoder.encode(
    `id: ${cursor}\nevent: trajectory\ndata: ${JSON.stringify(record)}\n\n`,
  );
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; slotId: string }> },
) {
  const { id, slotId } = await params;
  const url = new URL(request.url);
  const sessionKey = url.searchParams.get('sessionKey')?.trim();
  const parsedTool = AgentToolSchema.safeParse(url.searchParams.get('agentTool'));
  const agentId = Number(slotId);
  const after =
    request.headers.get('last-event-id') ??
    url.searchParams.get('after') ??
    undefined;

  if (!sessionKey) return new Response('sessionKey is required', { status: 400 });
  if (!parsedTool.success) return new Response('agentTool is invalid', { status: 400 });
  if (!Number.isInteger(agentId) || agentId < 1) {
    return new Response('slotId is invalid', { status: 400 });
  }
  if (after) {
    try {
      decodeTrajectoryCursor(after);
    } catch (error: unknown) {
      return new Response(error instanceof Error ? error.message : String(error), { status: 400 });
    }
  }

  const scope: TrajectoryScope = {
    repositoryId: id,
    agentId,
    sessionKey,
    agentTool: parsedTool.data,
  };
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const pending: AgentTrajectoryRecord[] = [];
      let replaying = true;
      const seen = new Set<string>();

      const send = (record: AgentTrajectoryRecord) => {
        if (closed || seen.has(record.id)) return;
        seen.add(record.id);
        controller.enqueue(trajectoryMessage(record));
      };
      const unsubscribe = subscribeToTrajectory(scope, (record) => {
        if (replaying) pending.push(record);
        else send(record);
      });
      const heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(': heartbeat\n\n'));
      }, 15_000);

      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // The client may already have closed the stream.
        }
      };
      cleanup = close;
      request.signal.addEventListener('abort', close, { once: true });

      void (async () => {
        try {
          if (after) {
            let replayCursor = after;
            while (!closed) {
              const records = await listTrajectoryAfter(scope, replayCursor);
              for (const record of records) send(record);
              if (records.length < 1_000) break;
              replayCursor = cursorForTrajectory(records[records.length - 1]);
            }
          }
          replaying = false;
          for (const record of pending) send(record);
          controller.enqueue(encoder.encode(': connected\n\n'));
        } catch (error: unknown) {
          if (!closed) {
            controller.enqueue(
              encoder.encode(
                `event: error\ndata: ${JSON.stringify({
                  message: error instanceof Error ? error.message : String(error),
                })}\n\n`,
              ),
            );
          }
          close();
        }
      })();
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
