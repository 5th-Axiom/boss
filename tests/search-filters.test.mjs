import {test} from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import {validateSearchFilters,readSearchFilters,applySearchFilters} from '../dist/toolset/search-filters.js';
import {readNormalSearchCandidates} from '../dist/toolset/normal-search.js';
const selection={degree:'本科及以上',schools:['985院校'],experience:'26年后毕业',activity:'今日活跃',jobChanges:'不限'};
test('只接受完整且合法的筛选字段',()=>{
 assert.deepEqual(validateSearchFilters(selection),selection);
 assert.throws(()=>validateSearchFilters({...selection,age:'20-25'}),/不支持/);
 assert.throws(()=>validateSearchFilters({...selection,schools:['985院校','985院校']}),/无效/);
});
test('按公开DOM读取、应用并验证筛选，空结果不混入推荐卡片',async()=>{
 const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH,headless:true});
 try{
  const page=await browser.newPage();
  const options=(labels,cls)=>labels.map((t,i)=>`<span class="${cls} ${i===0?'active':''}">${t}</span>`).join('');
  const dropdown=label=>`<div class="dropdown-wrap"><input placeholder="${label}"><span class="dropdown-select">打开</span><ul class="options"><li class="selected">不限</li><li>今日活跃</li></ul></div>`;
  await page.setContent(`<div class="degree-list-C">${options(['不限','本科及以上'],'degree-item')}</div><div class="exp-list-ui">${options(['不限','26年后毕业'],'exp-item')}</div><div class="school-ui"><div class="school-item"><label>985院校</label></div><div class="school-item"><label>211院校</label></div></div>${dropdown('牛人活跃度')}${dropdown('跳槽频率')}`);
  await page.evaluate(`document.querySelectorAll('.degree-item,.exp-item').forEach(n=>n.onclick=()=>{n.parentElement.querySelectorAll('.active').forEach(x=>x.classList.remove('active'));n.classList.add('active')});document.querySelectorAll('.school-item label').forEach(n=>n.onclick=()=>n.classList.toggle('checked'));document.querySelectorAll('.dropdown-select').forEach(n=>n.onclick=()=>n.parentElement.classList.toggle('dropdown-menu-open'));document.querySelectorAll('li').forEach(n=>n.onclick=()=>{n.parentElement.querySelector('.selected').classList.remove('selected');n.classList.add('selected');n.closest('.dropdown-wrap').classList.remove('dropdown-menu-open')})`);
  const frame=page.mainFrame();const result=await applySearchFilters(frame,selection);
  assert.deepEqual(result.find(g=>g.key==='schools').selected,['985院校']);assert.deepEqual(result.find(g=>g.key==='activity').selected,['今日活跃']);
  await assert.rejects(applySearchFilters(frame,{...selection,experience:'过期年份'}),/选项已变化/);
  assert.deepEqual((await readSearchFilters(frame)).find(g=>g.key==='experience').selected,['26年后毕业']);
  await page.setContent('<li class="geek-info-card"><a data-expect="123"><span class="name-label">测试</span></a></li>');
  assert.equal((await readNormalSearchCandidates(frame))[0].platformId,'expect:123');
  await page.setContent('<div class="rcd-data-tips">暂无相关牛人，请更换搜索词</div><div class="geek-info-card"><span class="name-label">推荐人选</span></div>');
  assert.deepEqual(await readNormalSearchCandidates(frame),[]);
 }finally{await browser.close()}
});
