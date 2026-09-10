import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, copyFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {createServer} from 'node:net';

test('批量自动入库、互斥、节奏、停止，服务重启后简历仍可访问', {timeout:170000}, async()=>{
 const dir=await mkdtemp(join(tmpdir(),'boss-batch-test-'));
 const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 let process;
 const origin=`http://127.0.0.1:${port}`;
 try {
  await mkdir(join(dir,'dist/web'),{recursive:true});await mkdir(join(dir,'dist/cli'),{recursive:true});await mkdir(join(dir,'screens'));
  for(const name of ['server.js','database.js','resume-retry.js','feishu.js'])await copyFile('dist/web/'+name,join(dir,'dist/web',name));
  await mkdir(join(dir,'dist/toolset'),{recursive:true});
  await copyFile('dist/toolset/candidate_result.js',join(dir,'dist/toolset/candidate_result.js'));
  await writeFile(join(dir,'package.json'),' {"type":"module"}');
  await writeFile(join(dir,'dist/config.js'),`export const RESUME_SCREENSHOTS_DIR=${JSON.stringify(join(dir,'screens'))};`);
  await writeFile(join(dir,'screens/resume.png'),'test-resume-bytes');
  const candidates=['甲','乙','丙','丁'].map((name,i)=>({name,platformId:String(i),token:'token'+i,basicInfo:`${20+i}岁`,salary:'',summary:'测试简介',expectation:'',work:[],education:'',tags:[],active:''}));
  await writeFile(join(dir,'dist/cli/index.js'),`import {appendFileSync} from 'node:fs';const command=process.argv[2];if(command==='preview')appendFileSync(${JSON.stringify(join(dir,'preview-log'))},process.argv[3]+'\\n');if(command==='preview'&&process.argv[3]==='丙'){console.log(JSON.stringify({error:'测试：这份简历不可访问',code:'COMMAND_ERROR'}));process.exit(1)}console.log(JSON.stringify(command==='preview'?{imagePath:${JSON.stringify(join(dir,'screens/resume.png'))}}:{source:command==='list-more'?process.argv[5]:command,context:'测试岗位',candidates:command==='list-more'?${JSON.stringify(candidates)}:${JSON.stringify(candidates.slice(0,2))}}));`);
  async function start(){
   process=spawn(globalThis.process.execPath,[join(dir,'dist/web/server.js')],{env:{...globalThis.process.env,BOSS_UI_PORT:String(port),BOSS_DATABASE_DIR:join(dir,'data')},stdio:'pipe'});
   await new Promise((resolve,reject)=>{process.stdout.on('data',()=>resolve());process.on('error',reject);process.on('exit',code=>reject(Error('server exit '+code)));});
   return (await (await fetch(origin+'/api/session')).json()).csrf;
  }
  let csrf=await start();
  const post=(path,payload)=>fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json','X-Boss-Token':csrf},body:JSON.stringify(payload)});
  const started=Date.now();assert.equal((await post('/api/batch',{source:'recommend',keyword:''})).status,202);
  assert.equal((await post('/api/command',{command:'recommend',keyword:''})).status,409);
  let session;
  do {await delay(150);session=await(await fetch(origin+'/api/session')).json()}while(session.batch.completed<1 && session.batch.status==='running');
  assert.equal(session.batch.completed,1);assert.ok(Date.now()-started>=15000);
  assert.equal((await post('/api/batch/stop',{})).status,200);
  do {await delay(50);session=await(await fetch(origin+'/api/session')).json()}while(session.busy);
  assert.equal(session.batch.status,'stopped');assert.equal(session.batch.completed,1);
  const local=await(await fetch(origin+'/api/local')).json();assert.equal(local.total,2);
  const saved=local.candidates.find(c=>c.imageUrl);assert.ok(saved);
  process.kill();await new Promise(r=>process.on('exit',r));csrf=await start();
  assert.equal(await(await fetch(origin+saved.imageUrl)).text(),'test-resume-bytes');
  assert.equal((await(await fetch(origin+'/api/local')).json()).total,2);
  assert.equal((await(await fetch(origin+'/api/session')).json()).batch,null);
  assert.equal((await post('/api/batch',{source:'recommend',keyword:'',limit:0})).status,400);
  assert.equal((await post('/api/batch',{source:'recommend',keyword:'',limit:1.5})).status,400);
  assert.equal((await post('/api/batch',{source:'recommend',keyword:'',limit:2})).status,202);
  do {await delay(100);session=await(await fetch(origin+'/api/session')).json()}while(session.busy);
  assert.equal(session.batch.status,'complete',session.batch.error);
  assert.equal(session.batch.completed,2);assert.equal(session.batch.skipped,1);
  assert.equal(session.batch.failures.length,1);assert.equal(session.batch.failures[0].name,'丙');
  assert.match(session.batch.failures[0].reason,/不可访问/);
  const afterBatch=await(await fetch(origin+'/api/local')).json();assert.equal(afterBatch.total,4);
  assert.match(afterBatch.candidates.find(c=>c.name==='丙').resumeFailure.reason,/不可访问/);
  const {readFile}=await import('node:fs/promises');
  assert.deepEqual((await readFile(join(dir,'preview-log'),'utf8')).trim().split('\n'),['甲','乙','丙','丁']);
  assert.equal((await post('/api/batch',{source:'recommend',keyword:'',limit:1})).status,202);
  do {await delay(100);session=await(await fetch(origin+'/api/session')).json()}while(session.busy);
  assert.equal(session.batch.status,'failed');assert.equal(session.batch.completed,0);assert.equal(session.batch.skipped,3);
  assert.match(session.batch.error,/未发现新的候选人/);

 }finally{if(process?.exitCode===null){process.kill();await new Promise(r=>process.on('exit',r));}await rm(dir,{recursive:true,force:true});}
});
