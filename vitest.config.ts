import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { fileURLToPath } from 'node:url';

const alias = {
  '@': fileURLToPath(new URL('./src', import.meta.url)),
};

/**
 * Two isolated projects, per the M1 testing contract:
 *
 *   unit — pure numerical/simulation correctness. Node, zero WebGL, zero DOM.
 *          Must never be weakened to accommodate browser/CI limitations.
 *   gl   — real headless Chromium + WebGL. Renders the depth-slab pipeline and
 *          asserts render-state properties. Infrastructure failures here are
 *          reported separately and do not relax `unit`.
 *
 * Headless Chromium has no GPU, so WebGL is served by ANGLE/SwiftShader
 * software rasterization. Flags below are required for a valid GL context.
 */
export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['test/unit/**/*.test.ts'],
          testTimeout: 20_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'gl',
          include: ['test/gl/**/*.test.ts'],
          testTimeout: 60_000,
          browser: {
            enabled: true,
            headless: true,
            screenshotFailures: false,
            provider: playwright({
              launchOptions: {
                args: [
                  '--use-gl=angle',
                  '--use-angle=swiftshader',
                  '--enable-unsafe-swiftshader',
                  '--ignore-gpu-blocklist',
                ],
              },
            }),
            instances: [
              {
                browser: 'chromium',
                viewport: { width: 1280, height: 720 },
              },
            ],
          },
        },
      },
    ],
  },
});
