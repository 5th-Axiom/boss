import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FeishuClient,FEISHU_FIELDS,syncToFeishu} from '../dist/web/feishu.js';
const config={appId:'test',appSecret:'test',wikiToken:'wiki',tableId:'table'};
function fixture() {
 const records=[],batches=[],uploads=[];let fail=false;const seen=new Map();
 const request=async (url,options={})=>{
  let data={};
  if(url.includes('auth/v3')) return Response.json({code:0,tenant_access_token:'test',expire:7200});
  if(url.includes('get_node')) data={node:{obj_type:'bitable',obj_token:'base'}};
  else if(url.includes('/fields')) data={items:FEISHU_FIELDS,has_more:false};
  else if(url.includes('/medias/')) {uploads.push(options.body);data={file_token:'attachment'+uploads.length};}
  else if(url.includes('/batch_create')) {
   const key=new URL(url).searchParams.get('client_token');const body=JSON.parse(options.body);
   batches.push({key,...body});
   if(!seen.has(key)) {seen.set(key,body.records);records.push(...body.records);}
   if(fail) {fail=false;throw new Error('模拟：服务端成功后连接中断');}
   data={records:seen.get(key)};
  } else if(url.includes('/records')) data={items:records,has_more:false};
  else throw new Error('unexpected '+url);
  return Response.json({code:0,data});
 };
 return {client:new FeishuClient(config,request),records,batches,uploads,setFail:()=>{fail=true;}};
}
const progress=()=>({status:'running',total:0,completed:0,skipped:0,phase:''});
test('全部本地数据按50条分批、跳过已有、提取四项和上传附件',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'feishu-test-'));const f=fixture();
 try {
  const path=join(directory,'resume.png');await writeFile(path,'test-image');
  const candidates=Array.from({length:102},(_,i)=>({syncKey:'key'+i,name:'测试'+i,basicInfo:'22岁 / 28年应届生 / 本科 / 刚刚活跃',resumePath:path}));
  candidates.push({syncKey:'no-resume',name:'未采集',basicInfo:'',resumePath:null});
  f.records.push({fields:{'同步标识':[{text:'key0'}]}});
  const db={directory,syncCandidates:()=>candidates};const state=progress();
  await syncToFeishu(db,f.client,state,()=>{});
  assert.equal(state.completed,101);assert.equal(state.skipped,1);assert.equal(state.total,102);assert.equal(state.withoutResume,1);
  assert.deepEqual(f.batches.map(b=>b.records.length),[50,50,1]);assert.equal(f.uploads.length,101);
  assert.equal(f.uploads[0].get('parent_type'),'bitable_file');assert.equal(f.uploads[0].get('parent_node'),'base');
  const fields=f.records[1].fields;assert.equal(fields['年龄'],22);assert.equal(fields['毕业／经验标签'],'28年应届生');assert.equal(fields['学历'],'本科');assert.deepEqual(fields['简历附件'],[{file_token:'attachment1'}]);
  const second=progress();await syncToFeishu(db,f.client,second,()=>{});
  assert.equal(second.completed,0);assert.equal(second.skipped,102);assert.equal(f.uploads.length,101);assert.equal(f.batches.length,3);
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('写入后响应丢失，重启后复用持久化请求标识，不重复创建',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'feishu-test-'));const f=fixture();
 try {
  const path=join(directory,'resume.png');await writeFile(path,'test-image');
  const db={directory,syncCandidates:()=>[{syncKey:'a',name:'测试',basicInfo:'22岁 / 3年 / 硕士',resumePath:path}]};f.setFail();
  await assert.rejects(syncToFeishu(db,f.client,progress(),()=>{}),/连接中断/);
  const journal=JSON.parse(await readFile(join(directory,'feishu/base-table.json'),'utf8'));
  const second=progress();await syncToFeishu(db,f.client,second,()=>{});
  assert.equal(f.batches[1].key,journal.clientToken);assert.equal(f.records.length,1);assert.equal(second.skipped,1);
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('字段类型错误明确暴露，禁止写入记录',async()=>{
 const client=new FeishuClient(config,async url=>Response.json(url.includes('auth')?{code:0,tenant_access_token:'test',expire:7200}:{code:0,data:url.includes('get_node')?{node:{obj_type:'bitable',obj_token:'base'}}:{items:[{field_name:'姓名',type:2}],has_more:false}}));
 await assert.rejects(client.ensureSchema(),/姓名.*类型不正确/);
});
