import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { inflateSync } from 'node:zlib';

test('新启动 Chrome 后 CLI 正常退出，浏览器继续存活', async () => {
  if (!process.env.CHROME_PATH) throw new Error('请设置 CHROME_PATH，测试使用独立的无头 Chrome。');
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const profile = await mkdtemp(join(tmpdir(), 'boss-process-test-'));
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
      import { connectBrowser } from './dist/browser/cdp_browser.js';
      const browser = await connectBrowser();
      await browser.disconnect();
      console.log('detached');
    `], { timeout: 15000, env: { ...process.env, BOSS_BROWSER_REMOTE_DEBUGGING_PORT: String(port), BOSS_BROWSER_USER_DATA_DIR: profile, BOSS_BROWSER_HEADLESS: 'true' } });
    assert.equal(stdout.trim(), 'detached');
    const response = await fetch(`http://127.0.0.1:${port}/json/version`);
    assert.equal(response.status, 200);
  } finally {
    // Only this test's browser and profile are used; the user's Chrome is untouched.
    const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
    await browser.close();
  }
});


test('推荐简历以原生指针事件打开，并准确匹配姓名', async () => {
  const { openRecommendResumePreview } = await import('../dist/toolset/recommend.js');
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div class="card-list"><div class="card-item"><div class="candidate-card-wrap"><div class="card-inner" style="width:400px;height:100px"><div class="name-wrap"><span class="name">张三丰</span></div></div></div></div><div class="card-item"><div class="candidate-card-wrap"><div class="card-inner" style="width:400px;height:100px"><div class="name-wrap"><span class="name">张三</span></div></div></div></div></div>`);
    await page.evaluate(`(() => {
      for (const card of document.querySelectorAll('.card-inner')) {
        let pointerDown = false;
        card.addEventListener('pointerdown', event => { pointerDown = event.isTrusted; });
        card.addEventListener('click', event => {
          if (!event.isTrusted || !pointerDown) return;
          document.body.dataset.opened = card.querySelector('.name').textContent;
        });
      }
      document.querySelectorAll('.card-inner')[1].click();
    })()`);
    assert.equal(await page.evaluate('document.body.dataset.opened'), undefined);
    assert.equal(await openRecommendResumePreview(page.mainFrame(), '张三', true), true);
    assert.equal(await page.evaluate('document.body.dataset.opened'), '张三');
  } finally { await browser.close(); }
});

test('窄视口截图包含完整简历且恢复原视口', async () => {
  const { captureCResumeIframeToFile } = await import('../dist/common/c_resume_capture.js');
  const { readFile } = await import('node:fs/promises');
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 1, isMobile: false, hasTouch: false, isLandscape: false });
    await page.setContent(`<style>body{margin:0}nav{position:fixed;left:0;top:0;width:100px;height:100vh;background:black;z-index:10}.dialog-lib-resume{margin-left:150px}iframe{border:0;width:900px;height:1200px;display:block;background:white}</style><nav></nav><div class="dialog-lib-resume"><iframe src="about:blank#c-resume"></iframe></div>`);
    const dir = await mkdtemp(join(tmpdir(), 'boss-capture-test-'));
    const path = join(dir, 'resume.png');
    assert.equal(await captureCResumeIframeToFile(page, page.viewport(), path), true);
    const bytes = await readFile(path);
    assert.equal(bytes.readUInt32BE(16), 900);
    assert.equal(bytes.readUInt32BE(20), 1200);
    assert.equal(page.viewport().width, 800);
    assert.equal(page.viewport().height, 600);
    const chunks = [];
    for (let offset = 8; offset < bytes.length;) {
      const length = bytes.readUInt32BE(offset);
      if (bytes.toString('ascii', offset + 4, offset + 8) === 'IDAT') chunks.push(bytes.subarray(offset + 8, offset + 8 + length));
      offset += length + 12;
    }
    // 第一行第一个像素的各 PNG 滤波器预测值均为零。
    const raw = inflateSync(Buffer.concat(chunks));
    assert.ok([2, 6].includes(bytes[25]));
    assert.deepEqual([...raw.subarray(1,4)], [255,255,255], '简历左侧不应被黑色导航栏遮挡');
  } finally { await browser.close(); }
});

test('后台标签不激活原窗口，保留当前页焦点', async () => {
  const {createBackgroundPage} = await import('../dist/browser/cdp_browser.js');
  const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH,headless:true});
  try {
    const source=await browser.newPage();await source.bringToFront();
    assert.equal(await source.evaluate('document.visibilityState'),'visible');
    const background=await createBackgroundPage(browser);
    assert.equal(await source.evaluate('document.visibilityState'),'visible');
    assert.equal(await background.evaluate('document.visibilityState'),'hidden');
    await background.close();
  }finally{await browser.close();}
});

test('候选人列表滚动触发追加加载，不导航页面', async () => {
  const {scrollCandidateList}=await import('../dist/toolset/list-more.js');
  const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH,headless:true});
  try {
    const page=await browser.newPage();
    await page.setContent('<div id="list" style="height:400px;overflow-y:auto"><div class="card-inner" data-geekid="1" style="height:1200px">候选人一</div></div>');
    await page.evaluate(`document.querySelector('#list').addEventListener('scroll', () => {
      const list=document.querySelector('#list');
      if(list.scrollTop+list.clientHeight>=list.scrollHeight&&!document.querySelector('[data-geekid="2"]'))setTimeout(()=>list.insertAdjacentHTML('beforeend','<div class="card-inner" data-geekid="2">候选人二</div>'),100);
    })`);
    let navigations=0;page.on('framenavigated',()=>navigations++);
    await scrollCandidateList(page.mainFrame(),'.card-inner',()=>page.evaluate(`Array.from(document.querySelectorAll('.card-inner')).map(el=>el.getAttribute('data-geekid'))`));
    assert.equal(await page.$eval('#list',el=>el.scrollTop)>0,true);
    assert.ok(await page.$('[data-geekid="2"]'));
    assert.equal(navigations,0);
  }finally{await browser.close();}
});

test('body 的 overflow 传播到视口时，滚动实际 document.scrollingElement', async () => {
  const {scrollCandidateList}=await import('../dist/toolset/list-more.js');
  const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH,headless:true});
  try {
    const page=await browser.newPage();
    await page.setContent('<!doctype html><style>html{height:100%;overflow:visible}body{height:100%;margin:0;overflow-y:scroll}</style><div class="card-inner" data-geekid="1" style="height:1500px">候选人一</div>');
    assert.equal(await page.evaluate('document.scrollingElement.tagName'),'HTML');
    await page.evaluate(`window.addEventListener('scroll',()=>{
      if(scrollY+innerHeight>=document.scrollingElement.scrollHeight-2&&!document.querySelector('[data-geekid="2"]'))setTimeout(()=>document.body.insertAdjacentHTML('beforeend','<div class="card-inner" data-geekid="2">候选人二</div>'),100);
    })`);
    await scrollCandidateList(page.mainFrame(),'.card-inner',()=>page.evaluate(`Array.from(document.querySelectorAll('.card-inner')).map(el=>el.getAttribute('data-geekid'))`));
    assert.equal(await page.evaluate('document.body.scrollTop'),0);
    assert.ok(await page.evaluate('document.scrollingElement.scrollTop>0'));
    assert.ok(await page.$('[data-geekid="2"]'));
  }finally{await browser.close();}
});
