/**
 * webpack.config.js — CEP build for Bridge Illustrator plugin.
 *
 * Output layout (dist/)
 * ─────────────────────
 *   dist/panel.html       ← copied from src/panel.html
 *   dist/panel.js         ← bundled from src/panel.ts + ws-client.ts + @bridge/shared
 *   dist/CSInterface.js   ← copied from lib/CSInterface.js
 *   dist/jsx/bridge.jsx   ← copied from src/jsx/bridge.jsx (raw, not transpiled)
 *
 * The extension root is packages/ai-plugin/.  CSXS/manifest.xml points:
 *   MainPath   → ./dist/panel.html
 *   ScriptPath → ./dist/jsx/bridge.jsx
 *
 * CEP vs UXP differences
 * ──────────────────────
 * UXP used `require('illustrator')` / `require('uxp')` from inside
 * JavaScript — those were listed as webpack externals.  CEP does NOT expose
 * any native modules to the browser (Chromium) context; all Illustrator
 * access goes through cs.evalScript() → ExtendScript.  So there are no
 * externals needed here.
 *
 * The `target` is omitted (defaults to 'web'), which is correct for a
 * Chromium-based CEP panel.  `transpileOnly: true` is set on ts-loader so
 * that webpack skips full type-checking during the build — the remaining
 * UXP source files in src/ (ai-executor.ts etc.) are not imported by
 * panel.ts and will never be bundled, but they do reference UXP types that
 * would otherwise cause tsc errors.  A dedicated `tsc --noEmit` typecheck
 * run (not part of the build) can be re-enabled once those files are cleaned
 * up or excluded from tsconfig.
 */

const path       = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = {
  entry: './src/panel.ts',

  output: {
    filename: 'panel.js',
    path:     path.resolve(__dirname, 'dist'),
    // No libraryTarget — the panel bundle is loaded as a plain <script> tag
    // in a Chromium browser context, not as a CommonJS module.
  },

  resolve: {
    extensions: ['.ts', '.js'],
    fallback: {
      // fontmap.ts wraps `require('fs')` in a try/catch for optional use.
      // Setting this to false prevents a "module not found" webpack warning.
      fs: false,
    },
  },

  module: {
    rules: [
      {
        test: /\.ts$/,
        use: {
          loader: 'ts-loader',
          options: {
            // Skip full type-checking during bundle — only transpile.
            // This lets webpack ignore UXP source files that are not imported
            // by the entry point (panel.ts → ws-client.ts → @bridge/shared).
            transpileOnly: true,
          },
        },
        exclude: /node_modules/,
      },
    ],
  },

  // No externals — CEP panels have no access to UXP or Illustrator modules
  // from within the Chromium context.  bridge.jsx handles all host API calls.

  plugins: [
    new CopyPlugin({
      patterns: [
        // Panel HTML template
        { from: 'src/panel.html',       to: 'panel.html'       },
        // CEP browser bridge library (must load before panel.js)
        { from: 'lib/CSInterface.js',   to: 'CSInterface.js'   },
        // ExtendScript renderer — copied verbatim; NOT processed by webpack
        { from: 'src/jsx/bridge.jsx',   to: 'jsx/bridge.jsx'   },
        // NOTE: manifest.json (old UXP manifest) is intentionally NOT copied.
        // CEP uses CSXS/manifest.xml at the extension root instead.
      ],
    }),
  ],
};
