// Reproduces the useMarkdown pipeline outside React Native with stubbed native modules.
const Module = require('node:module');
const path = require('node:path');
const React = require('react');

const stubs = {
  'react-native': new Proxy({}, { get: (_, name) => name === 'StyleSheet' ? { create: s => s, flatten: s => Object.assign({}, ...[].concat(s).filter(Boolean)), absoluteFill: {} } : name === 'Dimensions' ? { get: () => ({ width: 400, height: 800 }) } : name === 'Platform' ? { OS: 'android', select: o => o.android ?? o.default } : name === 'Linking' ? { openURL: async () => {} } : name.startsWith('use') ? () => ({}) : name }),
  'react-native-svg': new Proxy({}, { get: (_, name) => name }),
  '@jsamr/react-native-li': new Proxy({}, { get: (_, name) => name }),
  '@jsamr/counter-style': new Proxy({}, { get: (_, name) => (name === 'default' ? { decimal: {}, disc: {} } : name) }),
  'react-native-reanimated-table': new Proxy({}, { get: (_, name) => name }),
};
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request in stubs) return `stub:${request}`;
  return originalResolve.call(this, request, ...rest);
};
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request in stubs) return stubs[request];
  return originalLoad.call(this, request, ...rest);
};

const root = path.join(__dirname, '..', 'node_modules', 'react-native-marked', 'dist', 'commonjs');
const { lexer } = require('marked');
const Parser = require(path.join(root, 'lib', 'Parser')).default;
const Renderer = require(path.join(root, 'lib', 'Renderer')).default;
const getStyles = require(path.join(root, 'theme', 'styles')).default;

const text = process.argv[2] ?? '# Hi\n\nSome **bold** and `code`.\n\n- a\n- b\n\n```ts\nconst x = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> quote\n\n[link](https://example.com)';
const styles = getStyles({}, 'dark', {});
const parser = new Parser({ styles, renderer: new Renderer({ selectable: true }) });
const tokens = lexer(text, { gfm: true });
const elements = parser.parse(tokens);
console.log('ok', elements.length, 'elements', React.isValidElement(elements[0]));
