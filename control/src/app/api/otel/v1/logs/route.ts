import { handleOtlpHttpExport } from '@/server/otlp-receiver';

export const runtime = 'nodejs';

/** OTLP/HTTP Export (JSON or protobuf); the response is a spec `Export*ServiceResponse`, always 200. */
export async function POST(request: Request) {
  return handleOtlpHttpExport('logs', request);
}
