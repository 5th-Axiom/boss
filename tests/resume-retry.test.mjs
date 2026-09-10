import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewWithRetry } from '../dist/web/resume-retry.js';
import { ResumeNotOpenedError } from '../dist/toolset/candidate_result.js';
const person={name:'甲',platformId:'42',token:'old'};
const result={source:'recommend',context:'岗位',candidates:[{...person,token:'new'}]};
function options(overrides={}) {return {signal:new AbortController().signal,preview:async()=>{},wait:async()=>{},readCurrent:async()=>result,saveCurrent:value=>value,...overrides};}

test('未打开时等待、按平台 ID 重新读取并使用新 token，成功后继续',async()=>{
 const events=[];
 const success=await previewWithRetry(person,'recommend',options({
  preview:async candidate=>{events.push(candidate.token);if(candidate.token==='old')throw new ResumeNotOpenedError();},
  wait:async retry=>events.push('wait'+retry),
  readCurrent:async()=>{events.push('read');return result;},
  saveCurrent:value=>{events.push('save');return value;},
 }));
 assert.equal(success,true);assert.deepEqual(events,['old','wait1','read','save','new']);
});
test('连续失败最多三次，不无限重试，最后保留原始错误',async()=>{
 let attempts=0,waits=0;
 await assert.rejects(previewWithRetry(person,'recommend',options({preview:async()=>{attempts++;throw new ResumeNotOpenedError();},wait:async()=>{waits++;}})),error=>error.code==='RESUME_NOT_OPENED');
 assert.equal(attempts,3);assert.equal(waits,2);
});
test('登录、额度、其他错误不重试',async()=>{
 for(const code of ['COMMAND_ERROR','STALE_LIST','QUOTA_EXCEEDED']) {
  let waits=0;const error=Object.assign(new Error(code),{code});
  await assert.rejects(previewWithRetry(person,'recommend',options({preview:async()=>{throw error;},wait:async()=>{waits++;}})),error);
  assert.equal(waits,0);
 }
});
test('等待中停止，不再读取或点击简历',async()=>{
 const abort=new AbortController();let reads=0;
 assert.equal(await previewWithRetry(person,'recommend',options({signal:abort.signal,preview:async()=>{throw new ResumeNotOpenedError();},wait:async()=>{abort.abort();throw Error('aborted');},readCurrent:async()=>{reads++;return result;}})),false);
 assert.equal(reads,0);
});
test('重试不能替换为同名不同 ID 的人，也不能接受来源变化',async()=>{
 for(const refreshed of [{...result,candidates:[{...person,platformId:'43'}]},{...result,source:'search'},{...result,candidates:[person,{...person,platformId:'43'}]}]) {
  let attempts=0;
  await assert.rejects(previewWithRetry(person,'recommend',options({preview:async()=>{attempts++;throw new ResumeNotOpenedError();},readCurrent:async()=>refreshed})));
  assert.equal(attempts,1);
 }
});
