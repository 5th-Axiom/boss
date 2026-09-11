import {test} from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import {assertPreviewCandidate,candidateToken,candidateAge,candidateProfile} from '../dist/toolset/candidate_result.js';
import {openRecommendResumePreview} from '../dist/toolset/recommend.js';
import {openNormalSearchResumePreview} from '../dist/toolset/normal-search.js';

test('同名不同年龄按组合校验，同名同龄保持歧义错误',()=>{
 const candidates=[{name:'刘欢',baseInfo:'21岁 / 本科'},{name:'刘欢',baseInfo:'25岁 / 硕士'}];
 assert.equal(candidateAge(candidates[1]),25);
 assert.doesNotThrow(()=>assertPreviewCandidate(candidates,'刘欢',candidateToken(candidates[1]),25));
 assert.throws(()=>assertPreviewCandidate(candidates,'刘欢',candidateToken(candidates[0]),25),/信息已变化/);
 assert.throws(()=>assertPreviewCandidate([...candidates,candidates[1]],'刘欢',candidateToken(candidates[1]),25),error=>error.code==='AMBIGUOUS_CANDIDATE');
});
test('推荐和搜索的实际卡片点击都匹配姓名与年龄',async()=>{
 const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH,headless:true});
 try {
  const page=await browser.newPage();
  await page.setContent('<div class="card-list"><div class="card-item"><div class="card-inner"><span class="name">刘欢</span><div class="base-info">21岁</div></div></div><div class="card-item"><div class="card-inner"><span class="name">刘欢</span><div class="base-info">25岁</div></div></div></div>');
  await page.evaluate(`document.querySelectorAll('.card-inner').forEach((el,i)=>el.addEventListener('click',()=>document.body.dataset.chosen=i))`);
  assert.equal(await openRecommendResumePreview(page.mainFrame(),'刘欢',true,25),true);
  assert.equal(await page.evaluate('document.body.dataset.chosen'),'1');
  await page.setContent('<div class="geek-info-card"><span class="name-label">刘欢</span><span class="info-labels">21岁</span><div class="info-detail">简介</div></div><div class="geek-info-card"><span class="name-label">刘欢</span><span class="info-labels">25岁</span><div class="info-detail">简介</div></div>');
  await page.evaluate(`document.querySelectorAll('.geek-info-card').forEach((el,i)=>el.addEventListener('click',()=>document.body.dataset.chosen=i))`);
  assert.equal(await openNormalSearchResumePreview(page.mainFrame(),'刘欢',true,25),true);
  assert.equal(await page.evaluate('document.body.dataset.chosen'),'1');
 }finally{await browser.close()}
});

test('四项组合区分同名同龄、不同毕业标签或学历，忽略活跃状态', () => {
 const candidates = ['25岁 / 28年应届生 / 本科', '25岁 / 27年应届生 / 本科', '25岁 / 28年应届生 / 硕士'].map(baseInfo => ({name:'刘欢',baseInfo}));
 for (const candidate of candidates) assert.doesNotThrow(() => assertPreviewCandidate(candidates,'刘欢',candidateToken(candidate),25));
 assert.equal(candidateProfile('25岁28年应届生本科刚刚活跃'),candidateProfile(candidates[0].baseInfo));
 assert.throws(() => assertPreviewCandidate([...candidates,{name:'刘欢',baseInfo:'25岁 / 28年应届生 / 本科 / 刚刚活跃'}],'刘欢',candidateToken(candidates[0]),25),error => error.code === 'AMBIGUOUS_CANDIDATE');
});
test('推荐和搜索实际点击同时匹配毕业标签和学历', async () => {
 const browser = await puppeteer.launch({executablePath:process.env.CHROME_PATH,headless:true});
 try {
  const page = await browser.newPage();
  const profiles = ['25岁28年应届生本科','25岁27年应届生硕士','25岁28年应届生硕士'];
  for (const source of ['recommend','search']) {
   await page.setContent('<div class="card-list">' + profiles.map(text => source === 'recommend'
    ? `<div class="card-item"><div class="card-inner"><span class="name">刘欢</span><div class="base-info">${text}</div></div></div>`
    : `<div class="geek-info-card"><span class="name-label">刘欢</span><span class="info-labels">${text}</span><div class="info-detail">简介</div></div>`).join('') + '</div>');
   await page.evaluate(`document.querySelectorAll('.card-inner,.geek-info-card').forEach((el,i)=>el.addEventListener('click',()=>document.body.dataset.chosen=i))`);
   const open = source === 'recommend' ? openRecommendResumePreview : openNormalSearchResumePreview;
   assert.equal(await open(page.mainFrame(),'刘欢',true,25,candidateProfile(profiles[2])),true);
   assert.equal(await page.evaluate('document.body.dataset.chosen'),'2');
  }
 } finally { await browser.close(); }
});

test('延迟渲染的技能标签不使身份校验失效，平台标识变化仍然拒绝', () => {
 const candidate={platformId:'expect:123',name:'李**',basicInfo:'25岁 / 3年 / 本科',tags:[]};
 const token=candidateToken(candidate);
 assert.doesNotThrow(()=>assertPreviewCandidate([{...candidate,tags:['React','AI']}],candidate.name,token,25));
 assert.throws(()=>assertPreviewCandidate([{...candidate,platformId:'expect:456'}],candidate.name,token,25),{code:'STALE_LIST'});
});
