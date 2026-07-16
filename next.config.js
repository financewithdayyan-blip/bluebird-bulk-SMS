/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return {
      beforeFiles: [
        { source: '/', destination: '/bluebird-app.html' },
      ],
    };
  },
};

module.exports = nextConfig;
