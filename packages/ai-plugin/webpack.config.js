const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = {
  entry: './src/panel.ts',
  output: {
    filename: 'panel.js',
    path: path.resolve(__dirname, 'dist'),
    libraryTarget: 'commonjs2',
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
  externals: {
    uxp: 'commonjs2 uxp',
    'photoshop': 'commonjs2 photoshop',
    'illustrator': 'commonjs2 illustrator',
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        { from: 'manifest.json', to: 'manifest.json' },
        { from: 'src/panel.html', to: 'panel.html' },
      ],
    }),
  ],
  target: 'node',
};
