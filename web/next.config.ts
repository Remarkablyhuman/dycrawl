import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // Douyin CDN domains for cover images
    remotePatterns: [
      { protocol: "https", hostname: "*.douyinpic.com"    },
      { protocol: "https", hostname: "*.douyinstatic.com" },
      { protocol: "https", hostname: "*.pstatp.com"       },
      { protocol: "https", hostname: "*.byteimg.com"      },
    ],
  },
};

export default nextConfig;
