/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      // Safety net — the old baked static sheet is still reachable at /legacy
      { source: '/legacy', destination: '/contact_sheet.html' },
    ];
  },
};

module.exports = nextConfig;
