import { runListMore } from '../toolset/list-more.js';
import { runLogin } from '../toolset/login.js';
import { runRecommend } from '../toolset/recommend.js';
import {validateSearchFilters} from '../toolset/search-filters.js';
import { runNormalSearch, runSearchFilterOptions } from '../toolset/normal-search.js';
import { runPreview } from '../toolset/preview.js';

/** Explicit machine interface; stdout contains exactly one JSON document. */
export async function executeJsonCommand(command: string, args: string[]): Promise<string> {
  const tail = args.filter(a => a !== '--json');
  if (command === 'list-more' || command === 'list-current') {
    if (tail.length !== 2 || tail[0] !== '--source' || !['recommend', 'search'].includes(tail[1])) throw new Error('用法: list-more --json --source recommend|search');
    return runListMore(tail[1] as 'recommend' | 'search', command === 'list-more');
  }
  if(command==='search-filters' && tail.length===0) return runSearchFilterOptions();
  if(command==='search' && tail.length===3 && tail[1]==='--filters') return runNormalSearch(tail[0],true,validateSearchFilters(JSON.parse(tail[2])));
  if (command === 'login' && tail.length === 0) {
    return JSON.stringify({ message: await runLogin() });
  }
  if (command === 'search' || command === 'recommend') {
    if (tail.length > 1 || tail.some(a => a.startsWith('-'))) throw new Error('JSON 查询仅接受一个用引号包裹的关键词。');
    return command === 'search' ? runNormalSearch(tail[0], true) : runRecommend(tail[0], true);
  }
  if (command === 'preview') {
    if (![5, 7].includes(tail.length) || (tail.length === 7 && (tail[5] !== '--age' || !/^\d{1,3}$/.test(tail[6]))) || tail[1] !== '--source' || tail[3] !== '--token' ||
        !['recommend', 'search'].includes(tail[2]) || !/^[a-f0-9]{64}$/.test(tail[4])) {
      throw new Error('用法: preview "姓名" --json --source recommend|search --token <列表返回的 token>');
    }
    return runPreview({ candidateTarget: tail[0], json: true,
      expectedAge: tail.length === 7 ? Number(tail[6]) : undefined,
      expectedSource: tail[2] as 'recommend' | 'search', expectedToken: tail[4] });
  }
  throw new Error(`命令 ${command} 不支持 --json 或参数不正确。`);
}
