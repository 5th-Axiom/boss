// UI fixtures are test-only; production never substitutes sample candidates.
// Start npm run ui, then CHROME_PATH=/path/to/chrome node tests/ui-browser.mjs.
import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.CHROME_PATH) throw new Error('浏览器测试需要 CHROME_PATH 指向 Chrome 可执行文件。');
const base = process.env.BOSS_UI_TEST_URL ?? 'http://127.0.0.1:3210';
const output = await mkdtemp(join(tmpdir(), 'boss-ui-review-'));
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH, headless: true });
const fixtures = [
  { name: '测试候选人甲', token: 'a'.repeat(64), basicInfo: '5 年经验 / 本科 / 上海', salary: '20–30K', summary: '测试资料：负责企业招聘平台的前端架构，关注复杂表单、组件设计与性能优化。', expectation: '上海 · 前端工程师 · 20–30K', work: ['测试科技有限公司 · 高级前端工程师 · 2021–至今', '示例软件团队 · 前端工程师 · 2019–2021'], education: '示例大学 · 计算机科学 · 本科', tags: ['React', 'TypeScript', '前端架构'], active: '测试状态' },
  { name: '测试候选人乙', token: 'b'.repeat(64), basicInfo: '3 年经验 / 硕士', salary: '', summary: '<img src=x onerror=alert(1)> 测试：此内容应显示为文本', expectation: '', work: [], education: '', tags: [], active: '' },
];
let batchPayload, syncClicked = false;
let listReadCount = 0;
let previewCount = 0, failSearch = false, emptySearch = false, stalePreview = false;
try {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/api/feishu/sync') { syncClicked=true;return request.respond({status:202,contentType:'application/json',body:JSON.stringify({status:'running',total:102,completed:0,skipped:1,phase:'正在上传测试简历'})}); }
    if (url.pathname === '/api/batch') { batchPayload = JSON.parse(request.postData()); return request.respond({status:202,contentType:'application/json',body:JSON.stringify({status:'running'})}); }
    if (url.pathname === '/api/local') return request.respond({ status:200, contentType:'application/json', body:JSON.stringify({source:'local',context:'本地保存 2 位候选人',total:2,candidates:fixtures.map((c,i)=>({...c,localId:'local-'+i,identityConfirmed:true,source:'recommend',context:'测试岗位',updatedAt:new Date().toISOString(),imageUrl:i===0?'/test-resume.svg':null}))}) });
    if (url.pathname === '/api/command') {
      const data = JSON.parse(request.postData());
      if (data.command === 'recommend' || data.command === 'search') listReadCount++;
      let result;
      if (failSearch) return request.respond({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '测试错误：Boss 登录已失效，请重新登录。' }) });
      if (data.command === 'preview' && stalePreview) return request.respond({ status: 409, contentType: 'application/json', body: JSON.stringify({ code: 'STALE_LIST', error: '测试：Boss 列表已变化，该候选人已不在当前列表。' }) });
      if (data.command === 'preview') { previewCount++; result = { imageUrl: '/test-resume.svg', name: fixtures[0].name }; }
      else result = { source: data.command, context: '测试数据 · 前端工程师', id: 'fixture-snapshot', candidates: emptySearch ? [] : fixtures };
      return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(result) });
    }
    if (url.pathname === '/test-resume.svg') return request.respond({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1100"><rect width="800" height="1100" fill="white"/><text x="60" y="80" font-size="28">TEST RESUME — synthetic fixture</text></svg>' });
    return request.continue();
  });
  await page.evaluateOnNewDocument(`(() => {
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(...args) { super(...args); window.testStatusEvents = this; }
    };
  })()`);
  await page.setViewport({ width: 1440, height: 1050 });
  await page.goto(base); await page.waitForSelector('#load:not([disabled])');
  const session = await (await fetch(`${base}/api/session`)).json();
  await page.evaluate(`window.testStatusEvents.dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify(JSON.stringify({csrf:'test-token',busy:true,operation:{command:'login',startedAt:Date.now()}}))} }))`);
  assert.equal(await page.$eval('#load', node => node.disabled), true);
  assert.match(await page.$eval('#notice', node => node.textContent), /打开 Boss 登录页/);
  await page.evaluate(`window.testStatusEvents.dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify(JSON.stringify({...session,busy:false,operation:null}))} }))`);
  assert.equal(await page.$eval('#load', node => node.disabled), false);
  await page.screenshot({ path: join(output, 'desktop-empty.png'), fullPage: true });
  await page.type('#keyword', '前端工程师'); await page.click('#load');
  await page.waitForSelector('.candidate');
  assert.equal((await page.$$('.candidate')).length, 2);
  assert.match(await page.$eval('#detail', node => node.textContent), /React/);
  await page.screenshot({ path: join(output, 'desktop-candidates.png'), fullPage: true });
  await page.click('.candidate:nth-child(2)');
  assert.equal(await page.$('#detail img'), null);
  assert.match(await page.$eval('#detail', node => node.textContent), /<img src=x/);
  await page.click('.candidate:first-child');
  await page.click('.resume-callout button'); await page.waitForSelector('.resume-image');
  await page.click('#tab-summary'); await page.click('.resume-callout button');
  assert.equal(previewCount, 1, 'Cached image should not invoke CLI again');
  const readsBeforeSwitch = listReadCount;
  await page.click('[data-view=local]');
  await page.waitForFunction('document.querySelector("#list-source").textContent === "本地数据库"');
  await page.click('.candidate:nth-child(2)');
  await page.type('#keyword','本地查询');
  await page.click('[data-view=online]');
  assert.equal(await page.$eval('#keyword',node=>node.value),'前端工程师');
  assert.equal((await page.$$('.candidate')).length,2);
  assert.equal(await page.$eval('.candidate.selected .candidate-name',node=>node.textContent),fixtures[0].name);
  assert.equal(await page.$eval('#tab-resume',node=>node.getAttribute('aria-selected')),'true');
  assert.ok(await page.$('.resume-image'));
  assert.equal(previewCount,1);
  assert.equal(listReadCount,readsBeforeSwitch,'切换回在线列表不得重新读取 Boss');

  await page.screenshot({ path: join(output, 'desktop-resume.png'), fullPage: true });
  await page.setViewport({ width: 390, height: 844 });
  await page.click('#tab-summary');
  await page.screenshot({ path: join(output, 'mobile-candidates.png'), fullPage: true });
  assert.equal(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
  await page.click('#load');
  await page.waitForSelector('.resume-callout button');
  stalePreview = true;
  await page.click('.resume-callout button');
  await page.waitForSelector('#reload-candidates');
  assert.equal(await page.$eval('.resume-callout button', node => node.disabled), true);
  assert.match(await page.$eval('#notice', node => node.textContent), /列表已变化/);
  stalePreview = false;
  await page.click('#reload-candidates');
  await page.waitForSelector('.resume-callout button:not([disabled])');
  assert.equal(await page.$eval('#error', node => node.hidden), true);
  await page.click('[data-source=search]');
  assert.equal(await page.$('.candidate'), null);
  emptySearch = true; await page.click('#load');
  await page.waitForFunction('document.querySelector("#count").textContent === "0"');
  failSearch = true; await page.click('#load');
  await page.waitForSelector('#error:not([hidden])');
  assert.match(await page.$eval('#error', node => node.textContent), /登录已失效/);
  assert.equal(await page.$('.candidate'), null);
  await page.click('[data-view=local]');
  await page.waitForFunction('document.querySelector("#list-source").textContent === "本地数据库"');
  assert.equal((await page.$$('.candidate')).length,2);
  const previewsBeforeLocal = previewCount;
  await page.click('.resume-callout button');await page.waitForSelector('.resume-image');
  assert.equal(previewCount,previewsBeforeLocal);
  await page.screenshot({path:join(output,'mobile-local.png'),fullPage:true});
  await page.click('.candidate:nth-child(2)');assert.equal(await page.$eval('.resume-callout button',n=>n.disabled),true);
  await page.setViewport({width:1440,height:1050});
  await page.evaluate(`window.testStatusEvents.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify(JSON.stringify({...session,busy:true,operation:{command:'batch'},batch:{id:'test',status:'running',total:2,completed:1,current:'测试候选人乙',phase:'waiting',nextAt:Date.now()+20000}}))}}))`);
  assert.equal(await page.$eval('#stop-batch',n=>n.disabled),false);
  assert.equal(await page.$eval('[data-view=online]',n=>n.disabled),false);
  await page.screenshot({path:join(output,'desktop-local-batch.png'),fullPage:true});
  await page.evaluate(`window.testStatusEvents.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify(JSON.stringify({...session,busy:true,operation:{command:'batch'},batch:{id:'test',status:'running',total:30,completed:1,skipped:2,current:'测试候选人乙',phase:'retrying',retry:1,nextAt:Date.now()+20000,failures:[{name:'测试候选人甲',age:25,reason:'这份简历暂不可访问，已跳过'}]}}))}}))`);
  assert.match(await page.$eval('#batch-detail',node=>node.textContent),/重新读取列表后重试/);
  assert.equal(await page.$eval('#batch-failures',node=>node.hidden),false);
  assert.match(await page.$eval('#batch-failure-list',node=>node.textContent),/25 岁.*暂不可访问/);
  assert.equal(await page.$eval('#stop-batch',node=>node.disabled),false);

  await page.evaluate(`window.testStatusEvents.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify(JSON.stringify({...session,busy:false,operation:null,batch:null}))}}))`);
  await page.click('[data-view=online]');
  assert.equal(await page.$eval('#collect-limit',node=>node.value),'30');
  await page.$eval('#collect-limit',node=>{node.value='7'});
  await page.click('#collect');
  await page.waitForSelector('#collect:not([disabled])');
  assert.equal(batchPayload.limit,7);
  assert.equal(batchPayload.source,'search');
  await page.click('[data-view=local]');
  await page.click('#sync-feishu');
  await page.waitForFunction('document.querySelector("#feishu-status").textContent.includes("正在上传测试简历")');
  assert.equal(syncClicked,true);
  await page.evaluate(`window.testStatusEvents.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify(JSON.stringify({...session,busy:true,operation:{command:'feishu'},batch:null,feishuSync:{status:'running',total:102,completed:50,skipped:1,phase:'正在上传测试候选人的简历'}}))}}))`);
  assert.equal(await page.$eval('#sync-feishu',n=>n.disabled),true);
  await page.screenshot({path:join(output,'desktop-feishu.png'),fullPage:true});
  await page.setViewport({width:390,height:844});
  await page.evaluate(`window.testStatusEvents.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify(JSON.stringify({...session,busy:false,operation:null,batch:null,feishuSync:{status:'failed',total:102,completed:50,skipped:1,error:'测试错误：附件上传权限不足'}}))}}))`);
  assert.equal(await page.$eval('#sync-feishu',n=>n.disabled),false);
  await page.screenshot({path:join(output,'mobile-feishu.png'),fullPage:true});
  assert.deepEqual(errors, []);
  console.log(`Browser UI checks passed. Screenshots: ${output}`);
} finally { await browser.close(); }
