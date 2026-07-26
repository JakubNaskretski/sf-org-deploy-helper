// Runnable contract check for discoverProjectRoot. No framework.
//   1) npm run compile   2) node scripts/check-project-discovery.cjs
const assert = require('assert');
const path = require('path');
const Module = require('module');

const state = { folders: [], results: new Map(), calls: [] };
class RelativePattern {
  constructor(base, pattern) {
    this.base = base;
    this.pattern = pattern;
  }
}
const Uri = { file: fsPath => ({ fsPath }) };
const vscode = {
  RelativePattern,
  Uri,
  workspace: {
    get workspaceFolders() { return state.folders; },
    findFiles: async (include, exclude, maxResults) => {
      state.calls.push({ include, exclude, maxResults });
      return (state.results.get(include.base.uri.fsPath) ?? []).map(Uri.file);
    },
    asRelativePath: uri => path.relative('workspace', uri.fsPath)
  }
};

const origLoad = Module._load;
Module._load = (request, ...rest) => request === 'vscode' ? vscode : origLoad(request, ...rest);
const { discoverProjectRoot } = require(path.join(__dirname, '..', 'out', 'metadataScanner.js'));

const folder = fsPath => ({ uri: Uri.file(fsPath), name: path.basename(fsPath), index: 0 });
const config = (...parts) => path.join(...parts, 'sfdx-project.json');

(async () => {
  state.folders = [];
  let result = await discoverProjectRoot();
  assert.strictEqual(result.root, undefined);
  assert.match(result.error, /No workspace folder/);

  state.calls = [];
  state.folders = [folder('workspace')];
  state.results = new Map([['workspace', [config('workspace', 'nested', 'project-one')]]]);
  result = await discoverProjectRoot();
  assert.strictEqual(result.root, path.join('workspace', 'nested', 'project-one'));
  assert.strictEqual(result.error, undefined);
  assert.strictEqual(state.calls.length, 1);
  assert.strictEqual(state.calls[0].include.pattern, '**/sfdx-project.json');
  assert.strictEqual(state.calls[0].exclude, '**/{node_modules,.git}/**');

  // Overlapping workspace folders can return the same config twice; discovery
  // must de-duplicate it and still select the one project.
  state.folders = [folder('workspace'), folder(path.join('workspace', 'nested'))];
  state.results = new Map([
    ['workspace', [config('workspace', 'nested', 'project-one')]],
    [path.join('workspace', 'nested'), [config('workspace', 'nested', 'project-one')]]
  ]);
  result = await discoverProjectRoot();
  assert.strictEqual(result.root, path.join('workspace', 'nested', 'project-one'));

  state.folders = [folder('workspace')];
  state.results = new Map([['workspace', [
    config('workspace', 'nested', 'project-one'),
    config('workspace', 'nested', 'project-two')
  ]]]);
  result = await discoverProjectRoot();
  assert.strictEqual(result.root, undefined);
  assert.match(result.error, /more than one Salesforce DX project/);
  assert.match(result.error, /project-one/);
  assert.match(result.error, /project-two/);

  state.results = new Map([['workspace', []]]);
  result = await discoverProjectRoot();
  assert.strictEqual(result.root, undefined);
  assert.match(result.error, /No Salesforce DX project found/);

  console.log('discoverProjectRoot: all checks passed (no workspace, nested, duplicate, multiple, none)');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
