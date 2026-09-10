import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { candidateToken, assertPreviewCandidate } from '../dist/toolset/candidate_result.js';
import { executeJsonCommand } from '../dist/cli/json.js';
import { openRecommendResumePreview } from '../dist/toolset/recommend.js';
import { openNormalSearchResumePreview } from '../dist/toolset/normal-search.js';
import vm from 'node:vm';
import { get } from 'node:http';

let server, origin, csrf;
before(async () => {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  origin = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['dist/web/server.js'], { env: { ...process.env, BOSS_UI_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('工作台启动超时')), 5000);
    server.once('error', reject);
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`工作台提前退出 ${code}`)); });
    server.stdout.once('data', () => { clearTimeout(timer); resolve(); });
  });
  csrf = (await (await fetch(`${origin}/api/session`)).json()).csrf;
});
after(async () => { if (server?.exitCode === null) { const ended = new Promise(resolve => server.once('exit', resolve)); server.kill(); await ended; } });
const post = (body, headers = {}) => fetch(`${origin}/api/command`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Boss-Token': csrf, ...headers }, body: JSON.stringify(body) });

test('候选人校验拒绝同名、模糊匹配和已变化内容', () => {
  const candidate = { name: '张三', summary: '工程师' };
  const token = candidateToken(candidate);
  assert.doesNotThrow(() => assertPreviewCandidate([candidate], '张三', token));
  assert.throws(() => assertPreviewCandidate([candidate, candidate], '张三', token), { code: 'AMBIGUOUS_CANDIDATE' });
  assert.throws(() => assertPreviewCandidate([candidate], '张', token), { code: 'STALE_LIST' });
  assert.throws(() => assertPreviewCandidate([{ ...candidate, summary: '变化' }], '张三', token), /已变化/);
});

test('结构化预览选择器不使用包含匹配', async () => {
  for (const open of [openRecommendResumePreview, openNormalSearchResumePreview]) {
    const evaluate = async script => {
      assert.equal(typeof script, 'string');
      const cards = [{ querySelector: () => ({ textContent: '张三丰' }) }];
      return vm.runInNewContext(script, { document: { querySelectorAll: () => cards }, HTMLElement: class {} });
    };
    const frame = { evaluate, evaluateHandle: async script => {
      const result = await evaluate(script);
      return { asElement: () => result, dispose: async () => {} };
    } };
    assert.equal(await open(frame, '张三', true), false);
  }
});

test('JSON 命令拒绝任意命令与非法参数，不触发浏览器', async () => {
  await assert.rejects(executeJsonCommand('send', ['--json']), /不支持/);
  await assert.rejects(executeJsonCommand('search', ['--json', '--bad']), /关键词/);
  await assert.rejects(executeJsonCommand('preview', ['张三', '--json']), /用法/);
});

test('工作台静态资源与本地会话正常', async () => {
  const res = await fetch(origin);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /候选人工作台/);
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(typeof csrf, 'string');
});

test('拒绝跨站、缺失令牌和伪造 Host', async () => {
  assert.equal((await post({ command: 'login' }, { Origin: 'https://example.com' })).status, 403);
  assert.equal((await post({ command: 'login' }, { 'X-Boss-Token': '' })).status, 403);
  const status = await new Promise((resolve, reject) => {
    get(`${origin}/api/session`, { headers: { Host: 'example.com' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(status, 403);
});

test('不暴露任意命令、任意文件和过期列表', async () => {
  assert.equal((await post({ command: 'send' })).status, 400);
  assert.equal((await post({ command: ['recommend'], keyword: '' })).status, 400);
  assert.equal((await post({ command: 'search', keyword: '--help' })).status, 400);
  assert.equal((await post({ command: 'search', keyword: '字'.repeat(21) })).status, 400);
  assert.equal((await post({ command: 'preview', snapshotId: 'expired', token: 'fake' })).status, 409);
  assert.equal((await fetch(`${origin}/api/resume/../../package.json`)).status, 404);
  assert.equal((await fetch(`${origin}/api/resume/unknown`)).status, 404);
});

test('非法 JSON 和过大请求明确报错', async () => {
  const res = await fetch(`${origin}/api/command`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Boss-Token': csrf }, body: '{' });
  assert.equal(res.status, 400);
  assert.equal((await post({ command: 'search', keyword: 'x'.repeat(9000) })).status, 413);
});

test('推荐卡片嵌套只读取一次，独立同名卡片仍保留', async () => {
  const { readRecommendList } = await import('../dist/toolset/recommend.js');
  const card = parent => ({
    parentElement: { closest: () => parent },
    matches: () => false,
    classList: { contains: () => false },
    getAttribute: () => null,
    querySelector: selector => selector === '.name-wrap .name' ? { textContent: '测试候选人' } : null,
    querySelectorAll: () => [],
  });
  const first = card(null), nested = card(first), second = card(null);
  const frame = { evaluate: async script => vm.runInNewContext(script, { document: { querySelectorAll: () => [first, nested, second] } }) };
  const candidates = await readRecommendList(frame);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].name, '测试候选人');
});

test('JSON CLI 错误穿过命令路由，保留结构化输出和非零退出码', async () => {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/cli/index.js', 'search', '--json', '--bad']);
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 1);
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).code, 'COMMAND_ERROR');
  assert.match(JSON.parse(result.stdout).error, /关键词/);
});
