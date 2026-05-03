const path = require('path');
const fs = require('fs');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyPlugin = require('copy-webpack-plugin');
const TerserPlugin = require('terser-webpack-plugin');

// Inlines the compiled ui.js into ui.html so the plugin is a single self-contained
// file. Figma's iframe context silently refuses to load external local scripts, so
// a <script src="ui.js"> tag causes the JS to never execute.
class InlineUIPlugin {
  apply(compiler) {
    compiler.hooks.afterEmit.tap('InlineUIPlugin', () => {
      const distDir = path.resolve(__dirname, 'dist');
      const htmlFile = path.join(distDir, 'ui.html');
      const jsFile = path.join(distDir, 'ui.js');
      try {
        const html = fs.readFileSync(htmlFile, 'utf8');
        const js = fs.readFileSync(jsFile, 'utf8');
        // Guard against </script> inside the JS source breaking the HTML parser.
        const safeJs = js.replace(/<\/script>/gi, '<\\/script>');
        const out = html.replace(
          /<script\b[^>]*\bsrc="ui\.js"[^>]*><\/script>/,
          `<script>${safeJs}</script>`
        );
        fs.writeFileSync(htmlFile, out, 'utf8');
        console.log(`[InlineUIPlugin] Inlined ui.js into ui.html (${js.length} chars)`);
      } catch (e) {
        console.warn('[InlineUIPlugin] Could not inline script:', e.message);
      }
    });
  }
}

const isProd = (argv) => argv.mode === 'production';

const legacyTerser = () =>
  new TerserPlugin({
    terserOptions: {
      ecma: 2017,
      compress: { ecma: 2017 },
      format: { ecma: 2017 },
    },
  });

const sandboxConfig = (_env, argv) => ({
  name: 'sandbox',
  target: ['web', 'es5'],
  mode: isProd(argv) ? 'production' : 'development',
  devtool: false,
  entry: { main: './src/main.ts' },
  module: {
    rules: [{ test: /\.ts$/, use: 'ts-loader', exclude: /node_modules/ }],
  },
  resolve: { extensions: ['.ts', '.js'] },
  output: {
    filename: '[name].js',
    path: path.resolve(__dirname, 'dist'),
    environment: {
      arrowFunction: false,
      const: false,
      destructuring: false,
      optionalChaining: false,
      templateLiteral: false,
    },
  },
  optimization: {
    minimize: isProd(argv),
    minimizer: [legacyTerser()],
  },
  plugins: [
    new CopyPlugin({
      patterns: [{ from: 'manifest.json', to: '../manifest.json' }],
    }),
  ],
});

// UI entry: standard browser bundle rendered inside Figma's iframe.
const uiConfig = (_env, argv) => ({
  name: 'ui',
  target: 'web',
  mode: isProd(argv) ? 'production' : 'development',
  devtool: isProd(argv) ? false : 'inline-source-map',
  entry: { ui: './src/ui.ts' },
  module: {
    rules: [{ test: /\.ts$/, use: 'ts-loader', exclude: /node_modules/ }],
  },
  resolve: { extensions: ['.ts', '.js'] },
  output: {
    filename: '[name].js',
    path: path.resolve(__dirname, 'dist'),
    environment: {
      arrowFunction: false,
      const: false,
      destructuring: false,
      optionalChaining: false,
      templateLiteral: false,
    },
  },
  optimization: {
    minimize: isProd(argv),
    minimizer: [legacyTerser()],
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: './src/ui.html',
      filename: 'ui.html',
      chunks: ['ui'],
      inject: 'body',
    }),
    new InlineUIPlugin(),
  ],
});

module.exports = [sandboxConfig, uiConfig];
