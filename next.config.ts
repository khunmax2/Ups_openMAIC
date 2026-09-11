import type { NextConfig } from 'next';

/**
 * The path this deployment is served under, or undefined for the root.
 *
 * Read here and by `lib/base-path.ts` from the same variable, because the two
 * halves have to agree: Next prefixes the URLs it generates, and `apiPath()`
 * prefixes the ones the application writes. A mismatch is not a build error —
 * it is a working page whose every request goes to the wrong place.
 *
 * NEXT_PUBLIC_ because the browser half needs it, which also makes it a BUILD
 * argument: the value is compiled in, so changing it means rebuilding the
 * image, not restarting the container.
 */
const configuredBasePath = (process.env.NEXT_PUBLIC_STUDIO_BASE_PATH || '').replace(/\/+$/u, '');

const nextConfig: NextConfig = {
  ...(configuredBasePath ? { basePath: configuredBasePath } : {}),
  output: process.env.VERCEL ? undefined : 'standalone',
  outputFileTracingIncludes: {
    '/*': [
      'lib/server/agent-runtime/import-pptx-worker.mjs',
      'skills/openmaic/**',
      'skills/agent-runtime/**',
      // Fork addition. The app's sharp (0.35.x) links libvips at load time
      // through the dynamic linker, not through require(), so the tracer
      // copies @img/sharp-libvips-*/lib/index.js and leaves the .so behind.
      // Next's own older sharp is special-cased and arrives whole, which is
      // why the image carried libvips 8.17 and the app asked for 8.18. In the
      // container the failure is one line at boot -- "Agent runtime startup
      // failed ... Could not load the sharp module" -- and after it the job
      // runner and material extraction never start, while every page serves.
      // The Dockerfile asserts the module loads before the image is finished.
      'node_modules/.pnpm/@img+sharp-libvips-*/node_modules/@img/sharp-libvips-*/lib/**',
    ],
  },
  typescript: {
    tsconfigPath: process.env.NODE_ENV === 'production' ? 'tsconfig.build.json' : 'tsconfig.json',
  },
  transpilePackages: ['mathml2omml', 'pptxgenjs', '@openmaic/importer'],
  // These agent packages do a runtime `import(specifier)` with a computed
  // specifier (to lazily load node:fs/os/path without breaking browser/Vite
  // builds). webpack can't statically analyze that and bundling it throws
  // "Cannot find module as expression is too dynamic" at runtime on the server
  // (the "Edit with AI" Pro-mode path), which broke the #619 keep-alive e2e.
  // Mark them server-external so Next loads them natively and the dynamic
  // import resolves as a real Node call.
  serverExternalPackages: [
    '@earendil-works/pi-ai',
    '@earendil-works/pi-agent-core',
    '@openmaic/generation',
    // Optional peers of @openmaic/storage, reached through deliberately
    // untraced dynamic imports. Externalizing keeps them out of the bundle,
    // and the static anchor in lib/persistence/asset-byte-store.ts gets them
    // traced into the standalone image -- without it, S3 mode and redirect
    // egress cannot resolve their SDK in the shipped deployment.
    '@aws-sdk/client-s3',
    '@aws-sdk/s3-request-presigner',
  ],
  experimental: {
    proxyClientMaxBodySize: '200mb',
  },
  async headers() {
    const extraAncestors = process.env.ALLOWED_FRAME_ANCESTORS?.trim();
    const frameAncestors = extraAncestors ? `'self' ${extraAncestors}` : "'self'";

    return [
      {
        source: '/(.*)',
        headers: [
          // X-Frame-Options only supports SAMEORIGIN (no allow-list),
          // so we omit it when custom ancestors are configured.
          ...(!extraAncestors ? [{ key: 'X-Frame-Options', value: 'SAMEORIGIN' }] : []),
          {
            key: 'Content-Security-Policy',
            value: `frame-ancestors ${frameAncestors}`,
          },
        ],
      },
    ];
  },
};

export default nextConfig;
