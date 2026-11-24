/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  transpilePackages: ['@har/schemas'],
  // The OTLP/gRPC receiver (src/server/otlp-grpc.ts) loads grpc-js from node_modules at runtime.
  serverExternalPackages: ['@grpc/grpc-js'],
};

module.exports = nextConfig;
