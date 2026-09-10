import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CandidateDatabase } from '../dist/web/database.js';

test('平台 ID 更新、同名隔离、无 ID 独立保存、简历跨重启持久化', () => {
  const dir = mkdtempSync(join(tmpdir(),'boss-db-test-'));
  let db = new CandidateDatabase(dir);
  try {
    const candidate = { platformId:'42',name:'同名',token:'a',summary:'原始简介',basicInfo:'',salary:'',expectation:'',work:[],education:'',tags:[],active:'' };
    const one = db.saveList({source:'recommend',context:'岗位甲',candidates:[candidate]}).candidates[0];
    const image = join(dir,'test.png');writeFileSync(image,'test-image');
    assert.equal(db.hasResume('recommend','42'),false);
    db.saveResumeFailure(one.localId,'点击后未出现简历','RESUME_NOT_OPENED');
    db.close();db=new CandidateDatabase(dir);
    assert.equal(db.list('').candidates[0].resumeFailure.reason,'点击后未出现简历');
    assert.equal(db.list('').candidates[0].resumeFailure.code,'RESUME_NOT_OPENED');
    const resume = db.saveResume(one.localId,image);
    assert.equal(db.list('').candidates[0].resumeFailure,null);
    assert.equal(db.hasResume('recommend','42'),true);
    assert.equal(db.hasResume('recommend','43'),false);
    const two = db.saveList({source:'recommend',context:'岗位乙',candidates:[{...candidate,summary:'更新简介',token:'b'}]}).candidates[0];
    assert.equal(one.localId,two.localId);
    db.saveList({source:'recommend',context:'岗位乙',candidates:[{...candidate,platformId:'43'},{...candidate,platformId:''},{...candidate,platformId:''}]});
    assert.equal(db.list('').total,4);
    assert.equal(db.list('更新简介').total,1);
    db.close();db=new CandidateDatabase(dir);
    assert.equal(db.list('更新简介').candidates[0].imageUrl,resume.imageUrl);
    assert.equal(readFileSync(db.resumePath(resume.imageUrl.split('/').at(-1)),'utf8'),'test-image');
    assert.equal(db.resumePath('../../etc/passwd'),null);
    assert.throws(()=>db.saveResume('missing',image),/不存在/);
    assert.equal(db.list('',100).candidates.length,0);
  } finally {db.close();rmSync(dir,{recursive:true,force:true});}
});
