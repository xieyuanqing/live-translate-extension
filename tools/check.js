/** 独立仓库检查入口：语法、版本一致性、算法自检和会话竞态回归。 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..');

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

function scripts(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? scripts(file) : file.endsWith('.js') ? [file] : [];
  });
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
if (manifest.version !== pkg.version) throw new Error('manifest.json 与 package.json 版本不一致');

const files = [...scripts(path.join(ROOT, 'src')), ...scripts(__dirname)];
for (const file of files) run(['--check', file]);
console.log(`语法检查通过：${files.length} 个文件；版本 ${manifest.version}`);
run(['tools/selftest.js']);
run(['--test', 'tools/lifecycle.test.js', 'tools/video-subs.test.js']);
