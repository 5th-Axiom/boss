import { configuredFeishu, syncToFeishu, type SyncProgress } from './feishu.js';
import { candidateAge, candidateIdentity } from '../toolset/candidate_result.js';
import { previewWithRetry } from './resume-retry.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative, isAbsolute } from 'node:path';
import { randomUUID, randomInt } from 'node:crypto';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { CandidateDatabase } from './database.js';
import { RESUME_SCREENSHOTS_DIR } from '../config.js';
import type { CandidateResult } from '../toolset/candidate_result.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const assets = join(root, 'web');
const cli = join(root, 'dist/cli/index.js');
const port = Number(process.env.BOSS_UI_PORT ?? 3210);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('BOSS_UI_PORT 必须是 1024–65535 的整数。');
const database = new CandidateDatabase(process.env.BOSS_DATABASE_DIR ?? join(homedir(), '.boss-cli', 'data'));
const csrf = randomUUID();
const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
let busy = false;
let operation: { command: string; startedAt: number } | null = null;
const statusClients = new Set<ServerResponse>();
type BatchState = { id: string; status: 'running' | 'complete' | 'stopped' | 'failed'; total: number; completed: number; skipped: number; failures: Array<{name:string; age?:number; reason:string}>; current: string; phase: string; progressMessage?:string; refreshCount?:number; error?: string; retry?: number; retryReason?: string; nextAt?: number };
let batch: BatchState | null = null;
let batchAbort: AbortController | null = null;
let feishuSync: SyncProgress | null = null;
function sessionState() { return { csrf, busy, operation, batch, feishuSync }; }
function publishStatus() {
  const event = `data: ${JSON.stringify(sessionState())}\n\n`;
  for (const client of statusClients) client.write(event);
}
let snapshot: (CandidateResult & { id: string }) | undefined;

class HttpError extends Error {
  constructor(public status: number, message: string, public code = 'COMMAND_ERROR') { super(message); }
}
function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk.toString();
    if (Buffer.byteLength(raw) > 8192) throw new HttpError(413, '请求内容过大。');
  }
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new HttpError(400, '请求必须为 JSON 对象。'); }
}
async function runCli(args: string[], onProgress?: (event:{phase:string;message:string})=>void): Promise<unknown> {
  try {
    const execution = exec(process.execPath, [cli, ...args], {
      cwd: root, env: { ...process.env, BOSS_RESUME_OCR: '0' },
      timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
    });
    let pending='';
    if (onProgress) execution.child.stderr?.on('data', chunk => {
      pending+=chunk.toString();
      let newline:number;
      while ((newline=pending.indexOf('\n'))>=0) {
        const line=pending.slice(0,newline);pending=pending.slice(newline+1);
        if (!line.startsWith('[boss-progress]')) continue;
        const event=JSON.parse(line.slice('[boss-progress]'.length));
        if (['refreshing','waiting-list'].includes(event.phase) && typeof event.message==='string') onProgress(event);
      }
    });
    const {stdout}=await execution;
    return JSON.parse(stdout);
  } catch (e) {
    const error = e as Error & { stdout?: string; stderr?: string; killed?: boolean };
    if (!error.killed && error.stdout?.trim()) {
      const failure = JSON.parse(error.stdout) as { error: string; code: string };
      if (typeof failure.error !== 'string' || typeof failure.code !== 'string') throw new Error('CLI 返回的错误格式不正确。');
      if (failure.code === 'STALE_LIST') snapshot = undefined;
      throw new HttpError(failure.code === 'STALE_LIST' || failure.code === 'AMBIGUOUS_CANDIDATE' ? 409 : 500,
        failure.error, failure.code);
    }
    throw new Error(error.killed ? 'CLI 执行超过 120 秒，已终止。请检查 Boss 浏览器状态。' :
      `CLI ${args[0]} 执行失败：${error.stderr?.trim() || error.message}`);
  }
}
async function previewAndSave(candidate: CandidateResult['candidates'][number], source: string) {
  if (!candidate.localId) throw new Error('候选人尚未写入本地数据库。');
  try {
  const age = candidateAge(candidate);
  const args = ['preview', candidate.name, '--json', '--source', source, '--token', candidate.token];
  if (age !== undefined) args.push('--age', String(age));
  const result = await runCli(args) as { imagePath: string };
  const imagePath = await realpath(result.imagePath);
  const base = await realpath(RESUME_SCREENSHOTS_DIR);
  const rel = relative(base, imagePath);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || !imagePath.endsWith('.png')) throw new Error('CLI 返回了不合法的简历图片路径。');
  return { ...database.saveResume(candidate.localId, imagePath), name: candidate.name };
  } catch (error) {
    database.saveResumeFailure(candidate.localId,error instanceof Error ? error.message : String(error),(error as {code?:string}).code);
    throw error;
  }
}
async function runBatch(source: string, keyword: string, abort: AbortController) {
  const current = batch!;
  try {
    const result = await runCli([source, keyword, '--json']) as CandidateResult;
    if (result.source !== source || !Array.isArray(result.candidates)) throw new Error('CLI 返回的列表格式不正确。');
    const context = result.context;
    let pageResult = result;
    const visited = new Set<string>();
    while (!abort.signal.aborted && current.completed < current.total) {
      const unseen = pageResult.candidates.filter(candidate => {
        if (!candidate.platformId) {
          const key = 'unidentified:' + candidate.token;
          if (visited.has(key)) return false;
          visited.add(key); return true;
        }
        if (visited.has(candidate.platformId)) return false;
        visited.add(candidate.platformId);
        return true;
      });
      snapshot = { ...database.saveList({ ...pageResult, context, candidates: unseen }), id: randomUUID() };
      const captured = snapshot;
      for (const candidate of captured.candidates) {
        if (abort.signal.aborted || current.completed >= current.total) break;
        if (database.hasResume(source, candidate.platformId!)) {
          current.skipped++; publishStatus(); continue;
        }
        try {
        if (!candidate.platformId) throw new Error('缺少平台身份标识，无法可靠去重，已跳过。');
        const age = candidateAge(candidate);
        if (age === undefined) throw new Error('列表未提供年龄，无法按姓名和年龄定位。');
        if (pageResult.candidates.filter(c => candidateIdentity(c) === candidateIdentity(candidate)).length !== 1) throw new Error('存在姓名、年龄、毕业／经验标签和学历均相同的记录，无法唯一确认身份。');
        current.current = candidate.name;
        current.phase = 'waiting';
        const wait = randomInt(15_000, 25_001);
        current.nextAt = Date.now() + wait;
        publishStatus();
        try { await delay(wait, undefined, { signal: abort.signal }); }
        catch (error) { if (abort.signal.aborted) break; throw error; }
        current.nextAt = undefined;
        current.phase = 'preview'; publishStatus();
        current.retry = 0; current.retryReason = undefined;
        const saved = await previewWithRetry(candidate, captured.source, {
          signal: abort.signal,
          preview: async item => { current.phase = 'preview'; current.nextAt = undefined; publishStatus(); return previewAndSave(item, captured.source); },
          wait: async (retry, message) => {
            const wait = randomInt(15_000, 25_001);
            current.retry = retry; current.retryReason = message; current.phase = 'retrying';
            current.nextAt = Date.now() + wait;
            console.error(`[boss-ui] batch ${current.id} candidate ${candidate.platformId}: ${message}; retry ${retry}/2`);
            publishStatus();
            await delay(wait, undefined, { signal: abort.signal });
          },
          readCurrent: async () => await runCli(['list-current', '--json', '--source', source]) as CandidateResult,
          saveCurrent: result => database.saveList({ ...result, context }),
        });
        if (!saved) break;
        current.completed++; publishStatus();
        } catch (error) {
          const reason = (error as {code?:string})?.code === 'RESUME_NOT_OPENED' ? '多次尝试仍未打开简历，已跳过，继续采集下一位。' : error instanceof Error ? error.message : String(error);
          database.saveResumeFailure(candidate.localId!,reason,(error as {code?:string}).code);
          current.failures.push({ name: candidate.name, age: candidateAge(candidate), reason });
          current.nextAt = undefined;
          console.error(`[boss-ui] batch ${current.id} candidate ${candidate.platformId}: skipped after failure: ${reason}`);
          publishStatus();
        }
      }
      if (abort.signal.aborted || current.completed >= current.total) break;
      current.phase = 'scrolling'; current.progressMessage=undefined; current.current = ''; publishStatus();
      pageResult = await runCli(['list-more', '--json', '--source', source], event=>{current.phase=event.phase;current.progressMessage=event.message;if(event.phase==='refreshing')current.refreshCount=(current.refreshCount??0)+1;publishStatus();}) as CandidateResult;
      current.progressMessage=undefined;
      if (pageResult.source !== source || !Array.isArray(pageResult.candidates)) throw new Error('继续加载返回的候选人格式不正确。');
      if (!pageResult.candidates.some(c => c.platformId && !visited.has(c.platformId))) throw new Error('滚动后未发现新的候选人，已停止采集，已保存的数据保留。');
    }
    current.status = abort.signal.aborted ? 'stopped' : 'complete';
  } catch (error) {
    current.status = 'failed';
    current.error = error instanceof Error ? error.message : String(error);
    console.error(`[boss-ui] batch ${current.id}: ${current.error}`);
  } finally {
    current.nextAt = undefined;
    current.phase = 'done';
    busy = false; operation = null; batchAbort = null;
    publishStatus();
  }
}
const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    if (!allowedHosts.has(req.headers.host ?? '')) throw new HttpError(403, '仅允许本机地址访问。');
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) throw new HttpError(403, '不允许跨站请求。');
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === '/api/session') {
      return json(res, 200, sessionState());
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      statusClients.add(res);
      res.write(`data: ${JSON.stringify(sessionState())}\n\n`);
      res.on('close', () => statusClients.delete(res));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/local') {
      const query = url.searchParams.get('q') ?? '';
      const offset = Number(url.searchParams.get('offset') ?? 0);
      if (query.length > 100 || !Number.isInteger(offset) || offset < 0) throw new HttpError(400, '本地查询参数不正确。');
      return json(res, 200, database.list(query, offset));
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/local/resume/')) {
      const path = database.resumePath(url.pathname.slice('/api/local/resume/'.length));
      if (!path) throw new HttpError(404, '本地简历不存在。');
      const buffer = await readFile(path);
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(buffer);
    }
    if (req.method === 'POST' && url.pathname === '/api/feishu/sync') {
      if (req.headers['x-boss-token'] !== csrf || req.headers['content-type'] !== 'application/json') throw new HttpError(403, '请求校验失败，请刷新页面。');
      await body(req);
      if (busy) throw new HttpError(409, '已有操作正在执行，请完成后再同步。');
      busy=true; operation={command:'feishu',startedAt:Date.now()};
      feishuSync={status:'running',total:0,completed:0,skipped:0,phase:'准备同步'};
      const current=feishuSync;
      publishStatus();json(res,202,current);
      void (async () => {
        try { await syncToFeishu(database,await configuredFeishu(),current,publishStatus); }
        catch(error) { current.status='failed';current.error=error instanceof Error ? error.message : '同步发生未知错误';console.error('[feishu-sync]',current.error); }
        finally {busy=false;operation=null;publishStatus();}
      })();
      return;
    }
    if (req.method === 'POST' && ['/api/batch', '/api/batch/stop'].includes(url.pathname)) {
      if (req.headers['x-boss-token'] !== csrf || req.headers['content-type'] !== 'application/json') throw new HttpError(403, '请求校验失败，请刷新页面。');
      const data = await body(req);
      if (url.pathname.endsWith('/stop')) {
        if (!batchAbort) throw new HttpError(409, '没有正在执行的批量采集。');
        batchAbort.abort();
        return json(res, 200, { message: '已请求停止；当前简历完成保存后停止，不再打开下一人。' });
      }
      if (busy) throw new HttpError(409, '已有操作正在执行。');
      if (!['recommend','search'].includes(String(data.source)) || typeof data.keyword !== 'string' || data.keyword.startsWith('-') || data.keyword.length > (data.source === 'search' ? 20 : 100)) throw new HttpError(400, '采集来源或关键词不正确。');
      const limit = data.limit ?? 30;
      if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 500) throw new HttpError(400, '采集数量必须是 1–500 的整数。');
      busy = true; operation = { command:'batch', startedAt: Date.now() };
      batch = { id:randomUUID(), status:'running', total:Number(limit), completed:0, skipped:0, failures:[], current:'', phase:'list' };
      batchAbort = new AbortController(); snapshot = undefined;
      publishStatus();
      json(res, 202, batch);
      void runBatch(String(data.source), data.keyword, batchAbort);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/command') {
      if (req.headers['x-boss-token'] !== csrf || req.headers['content-type'] !== 'application/json') throw new HttpError(403, '请求校验失败，请刷新页面。');
      const data = await body(req);
      if (typeof data.command !== 'string' || !['login', 'recommend', 'search', 'preview'].includes(data.command)) throw new HttpError(400, '不支持的操作。');
      if (busy) throw new HttpError(409, `操作 ${operation!.command} 正在执行，请等待完成。`);
      const command = data.command as string;
      if (command === 'search' || command === 'recommend') {
        if (typeof data.keyword !== 'string' || data.keyword.startsWith('-') || data.keyword.length > (command === 'search' ? 20 : 100)) throw new HttpError(400, '关键词格式不正确（搜索最多 20 字，岗位最多 100 字，不能以 - 开头）。');
      }
      busy = true;
      operation = { command, startedAt: Date.now() };
      publishStatus();
      try {
        if (command === 'login') {
          snapshot = undefined;
          return json(res, 200, await runCli(['login', '--json']));
        }
        if (command === 'preview') {
          if (!snapshot || data.snapshotId !== snapshot.id) throw new HttpError(409, '列表已失效，请重新加载候选人。', 'STALE_LIST');
          const candidate = snapshot.candidates.find(c => c.token === data.token);
          if (!candidate) throw new HttpError(400, '候选人不在当前列表中。');
          if (snapshot.candidates.filter(c => candidateIdentity(c) === candidateIdentity(candidate)).length !== 1) {
            const reason='列表中有姓名、年龄、毕业／经验标签和学历均相同的候选人，请在 Boss 页面查看以确认身份。';
            database.saveResumeFailure(candidate.localId!,reason,'AMBIGUOUS_CANDIDATE');
            throw new HttpError(409,reason);
          }
          return json(res, 200, await previewAndSave(candidate, snapshot.source));
        }
        snapshot = undefined;
        const result = await runCli([command, data.keyword as string, '--json']) as CandidateResult;
        if (result.source !== command || !Array.isArray(result.candidates)) throw new Error('CLI 返回的数据格式不正确。');
        snapshot = { ...database.saveList(result), id: randomUUID() };
        return json(res, 200, snapshot);
      } finally { busy = false; operation = null; publishStatus(); }
    }
    const files: Record<string, [string, string]> = {
      '/': ['index.html', 'text/html; charset=utf-8'],
      '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
      '/style.css': ['style.css', 'text/css; charset=utf-8'],
    };
    if (req.method !== 'GET' || !files[url.pathname]) throw new HttpError(404, '页面不存在。');
    const [file, type] = files[url.pathname];
    const content = await readFile(join(assets, file));
    res.writeHead(200, { 'Content-Type': type });
    res.end(content);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(`[boss-ui] ${req.method} ${req.url}: ${message}`);
    json(res, status, { error: message, code: e instanceof HttpError ? (status === 409 && busy ? 'BUSY' : e.code) : 'COMMAND_ERROR' });
  }
});
server.listen(port, '127.0.0.1', () => console.log(`候选人工作台：http://127.0.0.1:${port}`));
server.on('error', error => { console.error(`工作台启动失败：${error.message}`); process.exitCode = 1; });
