import { candidateIdentity } from '../toolset/candidate_result.js';
import type { Candidate, CandidateResult } from '../toolset/candidate_result.js';

/** 仅重试已明确识别的“简历未打开”，最多共三次；每次重新按平台 ID 定位。 */
export async function previewWithRetry(candidate: Candidate, source: string, options: {
  signal: AbortSignal;
  preview: (candidate: Candidate) => Promise<unknown>;
  wait: (retry: number, message: string) => Promise<void>;
  readCurrent: () => Promise<CandidateResult>;
  saveCurrent: (result: CandidateResult) => CandidateResult;
}): Promise<boolean> {
  let current = candidate;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (options.signal.aborted) return false;
    try {
      await options.preview(current);
      return true;
    } catch (error) {
      if ((error as { code?: string })?.code !== 'RESUME_NOT_OPENED' || attempt === 2) throw error;
      try { await options.wait(attempt + 1, error instanceof Error ? error.message : String(error)); }
      catch (waitError) { if (options.signal.aborted) return false; throw waitError; }
      if (options.signal.aborted) return false;
      const result = await options.readCurrent();
      if (result.source !== source || !Array.isArray(result.candidates)) throw new Error('重试读取的候选人来源或数据格式不正确。');
      if (!candidate.platformId) throw new Error('缺少平台候选人 ID，不能安全重试。');
      const matching = result.candidates.filter(item => item.platformId === candidate.platformId);
      if (matching.length !== 1) throw new Error(`重试时无法按平台 ID 唯一定位“${candidate.name}”，已停止采集。`);
      if (result.candidates.filter(item => candidateIdentity(item) === candidateIdentity(matching[0])).length !== 1) throw new Error(`重试时“${matching[0].name}”存在姓名、年龄、毕业／经验标签和学历均相同的记录，无法唯一定位。`);
      current = options.saveCurrent({ ...result, candidates: matching }).candidates[0];
    }
  }
  return false;
}
