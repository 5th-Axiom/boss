import type { Frame } from 'puppeteer-core';
import { withBossSessionPage } from '../common/boss_session_page.js';
import { sleepRandom } from '../browser/timing.js';
import { assertRecommendPageReadyForPreview, readRecommendList, recommendResult } from './recommend.js';
import { assertNormalSearchPageReadyForPreview, readNormalSearchCandidates, normalSearchResult } from './normal-search.js';

/** 沿列表所在的滚动容器向下滚动；只等待新卡片，不刷新页面或重选岗位。 */
export async function scrollCandidateList(frame: Frame, selector: string, readIds: () => Promise<string[]>): Promise<void> {
  const baseline = new Set(await readIds());
  if (baseline.has('')) throw new Error('候选人缺少平台 ID，无法验证是否加载了新候选人。');
  let stationarySince: number | null = null;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
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
    if (position.moved) stationarySince = null;
    else if (!position.atBottom) throw new Error('候选人滚动容器未移动，但尚未到底部。请检查页面遮挡或滚动限制。');
    else {
      stationarySince ??= Date.now();
      if (Date.now() - stationarySince >= 6_000) throw new Error('列表已滚动到底部，等待 6 秒仍未出现更多候选人。采集已停止，已保存的数据保留。');
    }
  }
  throw new Error('向下滚动 45 秒仍未加载新候选人，已停止采集，请检查 Boss 列表状态。');
}

export async function runListMore(source: 'recommend' | 'search', scroll = true): Promise<string> {
  return withBossSessionPage(async page => {
    if (source === 'recommend') {
      const frame = await assertRecommendPageReadyForPreview(page);
      if (scroll) await scrollCandidateList(frame, '.card-inner', async () => (await readRecommendList(frame)).map(c => c.geekId));
      return JSON.stringify(recommendResult(await readRecommendList(frame), ''));
    }
    const frame = await assertNormalSearchPageReadyForPreview(page);
    if (scroll) await scrollCandidateList(frame, '.geek-info-card', async () => (await readNormalSearchCandidates(frame)).map(c => c.platformId));
    return JSON.stringify(normalSearchResult(await readNormalSearchCandidates(frame), ''));
  });
}
