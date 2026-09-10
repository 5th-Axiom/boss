import { createHash } from 'node:crypto';

export type Candidate = {
  platformId?: string;
  raw?: object;
  localId?: string;
  name: string;
  token: string;
  basicInfo: string;
  salary: string;
  summary: string;
  expectation: string;
  work: string[];
  education: string;
  tags: string[];
  active: string;
};
export type CandidateResult = {
  source: 'recommend' | 'search';
  context: string;
  candidates: Candidate[];
};
export function candidateToken(candidate: object): string {
  return createHash('sha256').update(JSON.stringify(candidate)).digest('hex');
}

export class CandidateSelectionError extends Error {
  constructor(public code: 'STALE_LIST' | 'AMBIGUOUS_CANDIDATE', message: string) {
    super(message);
    this.name = 'CandidateSelectionError';
  }
}

export function assertPreviewCandidate(candidates: Array<{ name: string; basicInfo?: string; baseInfo?: string }>, name: string, token: string, age?: number): string {
  const eligible = candidates.filter(candidate => candidate.name === name && (age === undefined || candidateAge(candidate) === age));
  if (!eligible.length) throw new CandidateSelectionError('STALE_LIST', `Boss 列表已变化，“${name}”已不在当前列表中，请重新加载。`);
  const selected = eligible.find(candidate => candidateToken(candidate) === token);
  if (!selected) throw new CandidateSelectionError('STALE_LIST', `“${name}”的列表信息已变化，请重新加载候选人后查看。`);
  const matching = eligible.filter(candidate => candidateIdentity(candidate) === candidateIdentity(selected));
  if (matching.length !== 1) throw new CandidateSelectionError('AMBIGUOUS_CANDIDATE', `“${name}”的姓名、年龄、毕业／经验标签和学历均有重复，无法唯一定位。`);
  return candidateProfile(selected.basicInfo ?? selected.baseInfo ?? '');
}

export class ResumeNotOpenedError extends Error {
  readonly code = 'RESUME_NOT_OPENED';
  constructor() { super('简历预览失败：点击后未出现在线简历 iframe（c-resume）。'); this.name = 'ResumeNotOpenedError'; }
}

export function candidateAge(candidate: { basicInfo?: string; baseInfo?: string }): number | undefined {
  const match = (candidate.basicInfo ?? candidate.baseInfo ?? '').match(/(\d{1,3})\s*岁/);
  return match ? Number(match[1]) : undefined;
}

/** 只使用列表的年龄、毕业／经验标签与学历，不包含活跃状态。 */
export function candidateProfile(text: string): string {
  const value = text.replace(/\s+/g, '');
  const age = value.match(/\d{1,3}岁/)?.[0] ?? '';
  const stage = value.match(/(?:\d{2,4}年)?应届生|\d+(?:-\d+)?年(?:以上|以下)?|在校生|经验不限|无经验/)?.[0] ?? '';
  const degree = value.match(/博士|硕士|研究生|本科|大专|专科|高中|中专|中技|初中(?:及以下)?|学历不限/)?.[0] ?? '';
  return JSON.stringify([age, stage, degree]);
}
export function candidateIdentity(candidate: {name: string; basicInfo?: string; baseInfo?: string}): string {
  return JSON.stringify([candidate.name, candidateProfile(candidate.basicInfo ?? candidate.baseInfo ?? '')]);
}
