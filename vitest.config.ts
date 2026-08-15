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
        /**
         * Pre-bundled explicitly, because discovering them mid-run makes the gate flaky.
         *
         * Vite optimises bare dependencies lazily. The three.js line addons are only
         * reached once a test imports OrbitPaths, so on a cold cache Vite discovers them
         * during the run, rebuilds, and reloads the page. Vitest reports that as
         * "Vite unexpectedly reloaded a test. This may cause tests to fail, lead to flaky
         * behaviour or duplicated test runs", which is exactly what a hard gate must not
         * do: a gate that can restart itself mid-assertion proves nothing.
         *
         * Listing them here means they are bundled before the first test executes.
         */
        optimizeDeps: {
          include: [
            'three',
            'three/addons/lines/Line2.js',
            'three/addons/lines/LineGeometry.js',
            'three/addons/lines/LineMaterial.js',
            'three/addons/lines/LineSegments2.js',
            'three/addons/lines/LineSegmentsGeometry.js',
          ],
        },
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
