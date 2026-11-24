/** Next.js startup hook: start the OTLP/gRPC receiver next to the HTTP routes (Node runtime only). */
export async function register(): Promise<void> {
  // This exact `if` form lets Next drop the import from the edge bundle.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startOtlpGrpcReceiver } = await import('./server/otlp-grpc');
    await startOtlpGrpcReceiver();
  }
}
