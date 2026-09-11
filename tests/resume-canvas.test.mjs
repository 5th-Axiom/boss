import test from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import {waitForVisibleCResumeIframeReady} from '../dist/common/c_resume_capture.js';
test('空白简历画布不能就绪，绘制正文后才能截图', async()=>{
 const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH,headless:true});
 try {
  const page=await browser.newPage();
  await page.setContent('<iframe src="about:blank#c-resume" srcdoc="<canvas id=resume width=800 height=600></canvas>" style="width:800px;height:600px"></iframe>');
  const frame=await (await page.$('iframe')).contentFrame();

  assert.equal(await waitForVisibleCResumeIframeReady(page,250),false);
  await frame.evaluate("document.querySelector('canvas').getContext('2d').fillRect(20,20,200,30)");
  assert.equal(await waitForVisibleCResumeIframeReady(page,500),true);
 } finally {await browser.close();}
});
