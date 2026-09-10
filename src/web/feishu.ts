import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { candidateProfile } from '../toolset/candidate_result.js';
import type { CandidateDatabase } from './database.js';

export const FEISHU_FIELDS = [{field_name:'姓名',type:1},{field_name:'年龄',type:2},{field_name:'毕业／经验标签',type:1},{field_name:'学历',type:1},{field_name:'简历附件',type:17},{field_name:'同步标识',type:1}];
type Config = {appId:string;appSecret:string;wikiToken:string;tableId:string};
type RecordInput = {fields: Record<string, unknown>};
export type SyncProgress = {status:'running'|'complete'|'failed'; total:number;completed:number;skipped:number;withoutResume?:number;phase:string;error?:string};
export class FeishuClient {
  private token = '';
  private expires = 0;
  appToken = '';
  constructor(private config:Config, private request:typeof fetch = fetch) {}
  async api(path:string, method='GET', payload?:unknown):Promise<any> {
    if (Date.now() >= this.expires) {
      const response = await this.request('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({app_id:this.config.appId,app_secret:this.config.appSecret}),signal:AbortSignal.timeout(30_000)});
      const result = await response.json() as any;
      if (!response.ok || result.code !== 0 || !result.tenant_access_token) throw new Error(`飞书应用认证失败（${result.code ?? response.status}），请检查服务端应用配置与权限。`);
      this.token = result.tenant_access_token; this.expires = Date.now() + (result.expire - 60) * 1000;
    }
    const multipart = payload instanceof FormData;
    const response = await this.request('https://open.feishu.cn/open-apis/'+path, {method,headers:{Authorization:'Bearer '+this.token,...(payload && !multipart ? {'Content-Type':'application/json'} : {})},body:payload ? multipart ? payload : JSON.stringify(payload) : undefined,signal:AbortSignal.timeout(120_000)});
    const result = await response.json() as any;
    if (!response.ok || result.code !== 0) throw new Error(`飞书 ${path.split('?')[0]} 失败（${result.code ?? response.status}）：${result.msg ?? '接口未返回错误说明'}。请检查应用权限及表格协作者权限。`);
    return result.data;
  }
  get tablePath() { return `bitable/v1/apps/${this.appToken}/tables/${this.config.tableId}`; }
  async resolve() {
    const data = await this.api('wiki/v2/spaces/get_node?token='+encodeURIComponent(this.config.wikiToken));
    if (data.node.obj_type !== 'bitable') throw new Error('飞书目标不是多维表格。');
    this.appToken = data.node.obj_token;
  }
  async list(path:string):Promise<any[]> {
    const items:any[] = []; let pageToken = '';
    do {
      const data = await this.api(path+'?page_size=100'+(pageToken ? '&page_token='+encodeURIComponent(pageToken) : ''));
      items.push(...data.items);
      if (!data.has_more) return items;
      if (!data.page_token || data.page_token === pageToken) throw new Error('飞书分页标识无效，已停止同步。');
      pageToken = data.page_token;
    } while (true);
  }
  async ensureSchema() {
    await this.resolve();
    const fields = await this.list(this.tablePath+'/fields');
    for (const required of FEISHU_FIELDS) {
      const existing = fields.find(f => f.field_name === required.field_name);
      if (existing) {
        if (existing.type !== required.type) throw new Error(`飞书字段“${required.field_name}”类型不正确：需要 ${required.type}，实际 ${existing.type}。请先调整字段类型。`);
        continue;
      }
      const primary = required.field_name === '姓名' && fields.find(f => f.field_name === '文本' && f.is_primary && f.type === 1);
      await this.api(this.tablePath+'/fields'+(primary ? '/'+primary.field_id : ''), primary ? 'PUT' : 'POST', required);
    }
  }
  async upload(path:string,name:string) {
    const bytes = await readFile(path);
    const form = new FormData();
    form.set('file_name',name); form.set('parent_type','bitable_file');form.set('parent_node',this.appToken);form.set('size',String(bytes.length));form.set('file',new Blob([bytes],{type:'image/png'}),name);
    const result = await this.api('drive/v1/medias/upload_all','POST',form);
    if (!result.file_token) throw new Error('飞书未返回简历附件标识。');
    return result.file_token as string;
  }
  async create(records:RecordInput[],clientToken:string) {
    const result = await this.api(this.tablePath+'/records/batch_create?client_token='+clientToken,'POST',{records});
    if (!Array.isArray(result.records) || result.records.length !== records.length) throw new Error('飞书返回的记录数量与提交数量不符，请再次同步以核对待确认批次。');
  }
}
export async function configuredFeishu() {
  const configPath = join(homedir(),'.boss-cli','feishu.json');
  let config:Config;
  try { config=JSON.parse(await readFile(configPath,'utf8')); }
  catch { throw new Error('无法读取服务端飞书配置 ~/.boss-cli/feishu.json，请检查文件及 JSON 格式。'); }
  if (![config.appId,config.appSecret,config.wikiToken,config.tableId].every(value => typeof value === 'string' && /^[a-zA-Z0-9_]+$/.test(value))) throw new Error('飞书配置缺少或包含无效的应用、知识库、数据表标识。');
  return new FeishuClient(config);
}
function fieldText(value:unknown):string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(item => item.text ?? '').join('');
  return '';
}
export async function syncToFeishu(database:CandidateDatabase, client:FeishuClient, progress:SyncProgress, publish:()=>void) {
  progress.phase='正在检查飞书字段'; publish(); await client.ensureSchema();
  const journalDir=join(database.directory,'feishu'); await mkdir(journalDir,{recursive:true,mode:0o700});
  const journal=join(journalDir,client.appToken+'-'+client.tablePath.split('/').at(-1)+'.json');
  let pending:{records:RecordInput[];clientToken:string}|undefined;
  try { pending=JSON.parse(await readFile(journal,'utf8')); } catch(error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (pending) {
    if (pending.records.some(record=>!Array.isArray(record.fields['简历附件']) || !record.fields['简历附件'].length)) throw new Error('上次待确认批次包含无简历记录，与当前仅同步有简历的规则不符。请先核对该历史批次，已暂停上传。');
    progress.phase='正在确认上次未完成的同步批次';publish();
    await client.create(pending.records,pending.clientToken); await unlink(journal);
  }
  progress.phase='正在读取飞书已有记录';publish();
  const existing=await client.list(client.tablePath+'/records');
  const keys=new Set(existing.map(record=>fieldText(record.fields['同步标识'])).filter(Boolean));
  const all=database.syncCandidates();
  const candidates=all.filter(candidate=>candidate.resumePath);
  progress.withoutResume=all.length-candidates.length;progress.total=candidates.length;publish();
  let records:RecordInput[]=[];
  async function flush() {
    if (!records.length) return;
    const batch={records,clientToken:randomUUID()};
    await writeFile(journal+'.tmp',JSON.stringify(batch),{mode:0o600});await rename(journal+'.tmp',journal);
    progress.phase=`正在写入飞书（本批 ${records.length} 条）`;publish();
    await client.create(records,batch.clientToken);
    await unlink(journal);
    progress.completed+=records.length;records=[];publish();
  }
  for (const candidate of candidates) {
    const key=candidate.syncKey;
    if (keys.has(key)) {progress.skipped++;publish();continue;}
    const [age,stage,degree]=JSON.parse(candidateProfile(candidate.basicInfo)) as string[];
    const fields:Record<string,unknown>={'姓名':candidate.name,'毕业／经验标签':stage,'学历':degree,'同步标识':key};
    if (age) fields['年龄']=Number(age.replace('岁',''));
    if (candidate.resumePath) {
      progress.phase=`正在上传 ${candidate.name} 的简历`;publish();
      fields['简历附件']=[{file_token:await client.upload(candidate.resumePath,candidate.name+'-简历.png')}];
    }
    records.push({fields}); keys.add(key);
    if (records.length === 50) await flush();
  }
  await flush();progress.status='complete';progress.phase='同步完成';publish();
}
