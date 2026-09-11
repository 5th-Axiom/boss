import {test} from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import {scrollCandidateList,refreshExhaustedList} from '../dist/toolset/list-more.js';
test('仅点击明确的列表刷新入口，等待替换列表，回报两个进度状态',async()=>{
 const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH,headless:true});
 try {
  const page=await browser.newPage();
  await page.setContent('<div class="card-inner" data-id="old">候选人</div><div class="no-data-refresh">当前列表没有更多牛人了，刷新获取最新列表<button class="btn-refresh">刷新</button></div>');
  await page.evaluate(`document.querySelector('button').addEventListener('click',()=>{document.body.dataset.clicks=Number(document.body.dataset.clicks||0)+1;setTimeout(()=>{document.querySelector('.card-inner').dataset.id='new'},300)})`);
  const events=[];let navigations=0;page.on('framenavigated',()=>navigations++);
  await scrollCandidateList(page.mainFrame(),'.card-inner',()=>page.evaluate(`Array.from(document.querySelectorAll('.card-inner')).map(n=>n.dataset.id)`),event=>events.push(event));
  assert.equal(await page.evaluate('document.body.dataset.clicks'),'1');assert.equal(navigations,0);
  assert.deepEqual(events.map(e=>e.phase),['refreshing','waiting-list']);
  await page.setContent('<button class="btn-refresh">刷新</button>');
  assert.equal(await refreshExhaustedList(page.mainFrame(),()=>assert.fail('不可点击无明确提示的按钮')),false);
 }finally{await browser.close()}
});
