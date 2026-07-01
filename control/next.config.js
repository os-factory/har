/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  transpilePackages: ['@har/schemas'],
};

module.exports = nextConfig;
