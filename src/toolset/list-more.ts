import type { Frame, ElementHandle } from 'puppeteer-core';
import { withBossSessionPage } from '../common/boss_session_page.js';
import { sleepRandom } from '../browser/timing.js';
import { assertRecommendPageReadyForPreview, readRecommendList, recommendResult } from './recommend.js';
import { assertNormalSearchPageReadyForPreview, readNormalSearchCandidates, normalSearchResult } from './normal-search.js';

export type ListProgress = {phase:'refreshing'|'waiting-list';message:string};
/** 仅识别 Boss 明确的列表末尾提示，点击其刷新按钮，不刷新浏览器整页。 */
export async function refreshExhaustedList(frame:Frame, progress:(event:ListProgress)=>void):Promise<boolean> {
  const handle=await frame.evaluateHandle(`(() => {
    const panels=Array.from(document.querySelectorAll('.no-data-refresh')).filter(node=>node.getBoundingClientRect().width>0 && getComputedStyle(node).visibility!=='hidden' && node.textContent.includes('当前列表没有更多牛人了'));
    if (panels.length!==1) return null;
    const button=panels[0].querySelector('button.btn-refresh');
    return button && button.textContent.trim()==='刷新' && !button.disabled ? button : null;
  })()`);
  try {
    const button=handle.asElement() as ElementHandle<Element>|null;
    if (!button) return false;
    progress({phase:'refreshing',message:'当前列表没有更多候选人，正在点击 Boss 列表底部的“刷新”…'});
    await button.click();
    progress({phase:'waiting-list',message:'已点击列表刷新，正在等待新的候选人；已采集数量和去重记录保留。'});
    return true;
  } finally {await handle.dispose();}
}
/** 沿列表滚动；遇到明确的列表末尾刷新入口时点击一次。 */
export async function scrollCandidateList(frame: Frame, selector: string, readIds: () => Promise<string[]>, progress:(event:ListProgress)=>void = () => {}): Promise<void> {
  const baseline = new Set(await readIds());
  if (baseline.has('')) throw new Error('候选人缺少平台 ID，无法验证是否加载了新候选人。');
  let refreshed=false;
  let stationarySince: number | null = null;
  let deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (refreshed) {
      await sleepRandom(900,1400);
      if ((await readIds()).some(id=>id && !baseline.has(id))) return;
      if (Date.now()-stationarySince!>=15_000) throw new Error('已点击 Boss 列表底部“刷新”，等待 15 秒仍未出现新候选人。采集已停止，已保存的数据保留。');
      continue;
    }
    const position = await frame.evaluate(`(() => {
      const card = document.querySelector(${JSON.stringify(selector)});
      if (!card) throw new Error('候选人列表已消失，无法继续滚动。');
      let node = card.parentElement;
      while (node && node !== document.body && node !== document.documentElement) {
        if (node.scrollHeight > node.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(node).overflowY)) break;
        node = node.parentElement;
      }
      const scroller = node && node !== document.body && node !== document.documentElement ? node : document.scrollingElement;
      if (!scroller) throw new Error('无法确定候选人列表滚动容器。');
      const before = scroller.scrollTop;
      scroller.scrollBy({ top: Math.max(300, Math.min(650, scroller.clientHeight * .7)), behavior: 'instant' });
      return { moved: scroller.scrollTop !== before, atBottom: scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2 };
    })()`) as { moved: boolean; atBottom: boolean };
    await sleepRandom(900, 1400);
    const ids = await readIds();
    if (ids.some(id => id && !baseline.has(id))) return;
    if (position.atBottom && await refreshExhaustedList(frame,progress)) {refreshed=true;stationarySince=Date.now();deadline=stationarySince+16_500;continue;}
    if (position.moved) stationarySince = null;
    else if (!position.atBottom) throw new Error('候选人滚动容器未移动，但尚未到底部。请检查页面遮挡或滚动限制。');
    else {
      stationarySince ??= Date.now();
      if (Date.now() - stationarySince >= 6_000) throw new Error('列表已滚动到底部，等待 6 秒仍未出现更多候选人，也未检测到可点击的列表刷新按钮。采集已停止，已保存的数据保留。');
    }
  }
  throw new Error('向下滚动 45 秒仍未加载新候选人，已停止采集，请检查 Boss 列表状态。');
}

export async function runListMore(source: 'recommend' | 'search', scroll = true): Promise<string> {
  const progress=(event:ListProgress)=>process.stderr.write('[boss-progress]'+JSON.stringify(event)+'\n');
  return withBossSessionPage(async page => {
    if (source === 'recommend') {
      const frame = await assertRecommendPageReadyForPreview(page);
      if (scroll) await scrollCandidateList(frame, '.card-inner', async () => (await readRecommendList(frame)).map(c => c.geekId),progress);
      return JSON.stringify(recommendResult(await readRecommendList(frame), ''));
    }
    const frame = await assertNormalSearchPageReadyForPreview(page);
    if (scroll) await scrollCandidateList(frame, '.geek-info-card', async () => (await readNormalSearchCandidates(frame)).map(c => c.platformId),progress);
    return JSON.stringify(normalSearchResult(await readNormalSearchCandidates(frame), ''));
  });
}
