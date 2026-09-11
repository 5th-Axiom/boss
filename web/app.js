const $ = selector => document.querySelector(selector);
const state = { view: 'online', batch: null, localOffset: 0, csrf: '', source: 'recommend', busy: false, remoteBusy: false, searchFilters: null };
const createViewState = () => ({ stale: false, result: null, selected: -1, tab: 'summary', images: new Map(), keyword: '' });
const views = { online: createViewState(), local: createViewState() };
// 两个工作区独立持有数据；切换视图只改变当前读写的工作区。
for (const key of ['stale', 'result', 'selected', 'tab', 'images']) {
  Object.defineProperty(state, key, {
    get: () => views[state.view][key],
    set: value => { views[state.view][key] = value; },
  });
}
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(text, className, action) {
  const node = element('button', className, text);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}
function notice(message, loading = false) {
  $('#notice').textContent = message;
  $('#notice').classList.toggle('loading', loading);
  $('#notice').classList.toggle('busy-label', loading);
}
function showError(error) {
  $('#error').replaceChildren(element('span', '', error.message));
  if (error.code === 'STALE_LIST') {
    const reload = button('重新加载候选人', 'secondary', () => $('#query').requestSubmit());
    reload.id = 'reload-candidates';
    $('#error').append(reload);
  }
  $('#error').hidden = false;
}
function syncBusy() {
  document.querySelectorAll('button,input').forEach(node => {
    const local = node.closest('#local-pager') || node.dataset.view || (state.view === 'local' && (node.closest('#query') || node.closest('#workspace')));
    node.disabled = !state.csrf || node.dataset.unavailable === 'true' || (!local && (state.busy || state.remoteBusy));
  });
  $('#search-filter-actions').hidden=state.view!=='online'||state.source!=='search';
  $('#stop-batch').disabled = !state.csrf || state.batch?.status !== 'running';
  $('#workspace').setAttribute('aria-busy', String(state.busy || state.remoteBusy));
  $('#load span').textContent = state.view === 'local' ? '查询本地数据' : (state.busy || state.remoteBusy) ? '正在处理…' : '加载候选人';
}
async function command(payload, message) {
  if (state.busy || state.remoteBusy) throw new Error('请等待当前操作完成。');
  state.busy = true;
  $('#error').hidden = true;
  notice(message, true);
  syncBusy();
  try {
    const response = await fetch('/api/command', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Boss-Token': state.csrf },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok) { const error = new Error(result.error); error.code = result.code; throw error; }
    return result;
  } finally {
    state.busy = false;
    syncBusy();
    $('#notice').classList.remove('loading', 'busy-label');
  }
}
const emptyDetail = $('#detail').cloneNode(true);
function resetResults() {
  state.stale = false; state.result = null; state.selected = -1; state.tab = 'summary'; state.images.clear();
  $('#count').textContent = '—';
  $('#list-context').textContent = '等待加载';
  $('#candidate-list').replaceChildren(element('p', 'list-empty', '选择来源并加载候选人。'));
  $('#detail').replaceChildren(...Array.from(emptyDetail.cloneNode(true).childNodes));
}
function renderList() {
  const result = state.result;
  $('#count').textContent = String(result.candidates.length);
  $('#list-source').textContent = result.source === 'local' ? '本地数据库' : result.source === 'recommend' ? '岗位推荐' : '关键词搜索';
  $('#list-context').textContent = result.context || '当前页面列表';
  const list = $('#candidate-list');
  list.replaceChildren();
  if (!result.candidates.length) {
    list.append(element('p', 'list-empty', '当前列表没有候选人。可修改关键词后重新加载。'));
    return;
  }
  result.candidates.forEach((candidate, index) => {
    const item = button('', `candidate${index === state.selected ? ' selected' : ''}`, () => {
      state.selected = index; state.tab = 'summary'; renderList(); renderDetail();
      if (matchMedia('(max-width: 680px)').matches) $('#detail').scrollIntoView({ behavior: 'instant', block: 'start' });
    });
    item.setAttribute('aria-pressed', String(index === state.selected));
    const top = element('div', 'candidate-top');
    top.append(element('span', 'candidate-name', candidate.name));
    if (candidate.salary) top.append(element('span', 'salary', candidate.salary));
    item.append(top, element('p', 'candidate-basic', candidate.basicInfo || '列表未提供基本信息'));
    if (state.view === 'local') item.append(element('p', 'saved-meta', `${candidate.imageUrl ? '已保存简历' : candidate.resumeFailure ? '简历获取失败' : '仅简介（未采集或历史原因未记录）'} · ${candidate.identityConfirmed ? '平台身份已记录' : '身份未确认，独立保存'}`));
    if (candidate.summary) item.append(element('p', 'candidate-summary', candidate.summary));
    list.append(item);
  });
  syncBusy();
}
function section(title, text) {
  const node = element('section', 'section');
  node.append(element('h3', '', title));
  if (Array.isArray(text) && text.length) {
    const list = element('ul'); text.forEach(line => list.append(element('li', '', line))); node.append(list);
  } else node.append(element('p', text ? '' : 'absent', text || '当前列表未提供这项信息，可按需查看完整简历。'));
  return node;
}
function previewButton(candidate) {
  const cached = state.images.has(candidate.token);
  if (state.view === 'local') {
    const control = button(cached ? '查看本地简历' : '尚未采集简历', 'primary', () => loadResume(candidate));
    if (!cached) { control.dataset.unavailable = 'true'; control.disabled = true; }
    return control;
  }
  const identity = candidate => {
    const value = candidate.basicInfo.replace(/\s+/g, '');
    return JSON.stringify([candidate.name,
      value.match(/\d{1,3}岁/)?.[0] ?? '',
      value.match(/(?:\d{2,4}年)?应届生|\d+(?:-\d+)?年(?:以上|以下)?|在校生|经验不限|无经验/)?.[0] ?? '',
      value.match(/博士|硕士|研究生|本科|大专|专科|高中|中专|中技|初中(?:及以下)?|学历不限/)?.[0] ?? '']);
  };
  const duplicate = state.result.candidates.filter(c => identity(c) === identity(candidate)).length !== 1;
  const control = button(cached ? '查看已加载的简历' : '查看完整简历', 'primary', () => loadResume(candidate));
  if (state.stale && !cached) { control.dataset.unavailable = 'true'; control.disabled = true; control.textContent = '列表已变化，请重新加载'; }
  if (duplicate) { control.dataset.unavailable = 'true'; control.disabled = true; control.textContent = '身份信息重复，请在 Boss 确认'; }
  return control;
}
function renderDetail() {
  const candidate = state.result?.candidates[state.selected];
  if (!candidate) return;
  const profile = element('article', 'profile');
  const heading = element('div', 'profile-heading');
  const identity = element('div');
  identity.append(element('h2', '', candidate.name), element('div', 'basic', [candidate.basicInfo, candidate.active].filter(Boolean).join(' · ') || '列表未提供基本信息'));
  heading.append(identity);
  if (candidate.salary) heading.append(element('div', 'profile-salary', candidate.salary));
  profile.append(heading);
  if (state.view === 'local' && candidate.resumeFailure) profile.append(element('p', 'saved-meta', `最近一次简历获取失败：${candidate.resumeFailure.reason} · ${new Date(candidate.resumeFailure.failedAt).toLocaleString('zh-CN')}`));
  if (state.view === 'local') profile.append(element('p', 'saved-meta', `来源：${candidate.source === 'recommend' ? '岗位推荐' : '关键词搜索'} · ${candidate.context || '未提供岗位'} · 更新于 ${new Date(candidate.updatedAt).toLocaleString('zh-CN')}${candidate.resumeUpdatedAt ? ' · 简历更新于 ' + new Date(candidate.resumeUpdatedAt).toLocaleString('zh-CN') : ''}`));
  if (candidate.tags.length) {
    const tags = element('div', 'tags'); [...new Set(candidate.tags)].forEach(tag => tags.append(element('span', 'tag', tag))); profile.append(tags);
  }
  const tabs = element('div', 'tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '候选人资料');
  for (const [key, label] of [['summary', '候选人简介'], ['resume', '完整简历']]) {
    const tab = button(label, '', () => { state.tab = key; renderDetail(); $(`#tab-${key}`).focus(); });
    tab.id = `tab-${key}`; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(state.tab === key)); tab.setAttribute('aria-controls', 'profile-panel'); tab.tabIndex = state.tab === key ? 0 : -1;
    tab.addEventListener('keydown', event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); state.tab = event.key === 'Home' ? 'summary' : event.key === 'End' ? 'resume' : state.tab === 'summary' ? 'resume' : 'summary'; renderDetail(); $(`#tab-${state.tab}`).focus(); } });
    tabs.append(tab);
  }
  profile.append(tabs);
  const panel = element('div'); panel.id = 'profile-panel'; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', `tab-${state.tab}`);
  if (state.tab === 'summary') {
    panel.append(section('个人简介与优势', candidate.summary), section('求职期望', candidate.expectation), section('工作经历', candidate.work.length ? candidate.work : ''), section('教育经历', candidate.education));
    const callout = element('div', 'resume-callout');
    callout.append(element('p', '', '这里是列表提供的简介。\n更完整的经历与项目，需打开在线简历查看。'), previewButton(candidate));
    panel.append(callout);
  } else if (state.images.has(candidate.token)) {
    const imageUrl = state.images.get(candidate.token);
    const tools = element('div', 'image-tools');
    const link = element('a', 'secondary', '新窗口放大查看'); link.href = imageUrl; link.target = '_blank'; link.rel = 'noopener';
    tools.append(element('span', '', '在线简历截图 · 已保存在本机'), link);
    const image = element('img', 'resume-image'); image.src = imageUrl; image.alt = `${candidate.name}的在线简历`;
    image.addEventListener('error', () => { state.images.delete(candidate.token); showError(new Error('简历图片加载失败，图片可能已失效，请重新查看。')); renderDetail(); });
    panel.append(tools, image);
  } else {
    const intro = element('div', 'resume-intro');
    intro.append(element('h3', '', '按需打开这份简历'), element('p', '', '将读取 Boss 在线简历并生成图片。\n此操作受平台每日查看额度限制。\nOCR 已关闭，截图不会发送到 OCR 服务。'), previewButton(candidate));
    panel.append(intro);
  }
  profile.append(panel); $('#detail').replaceChildren(profile); syncBusy();
}
async function loadResume(candidate) {
  if (state.images.has(candidate.token)) { state.tab = 'resume'; renderDetail(); return; }
  const snapshotId = state.result.id;
  try {
    const result = await command({ command: 'preview', snapshotId: state.result.id, token: candidate.token }, `正在打开 ${candidate.name} 的在线简历，请保持 Boss 页面不变…`);
    if (views.online.result?.id !== snapshotId) return;
    views.online.images.set(candidate.token, result.imageUrl); views.online.tab = 'resume';
    if (state.view !== 'online') return;
    renderDetail();
    notice('简历已加载。再次查看这张图片不会重新调用预览。');
  } catch (e) {
    if (e.code === 'STALE_LIST') views.online.stale = true;
    if (state.view !== 'online') return;
    if (e.code === 'STALE_LIST') {
      $('#list-context').textContent = '列表已失效 · 请重新加载候选人';
      renderDetail();
    }
    showError(e);
    notice(e.code === 'STALE_LIST' ? 'Boss 列表已变化，本次未打开简历。请重新加载列表。' : '简历未加载成功，请查看下方具体错误。');
  }
}
document.querySelectorAll('[data-source]').forEach(control => control.addEventListener('click', () => {
  if (state.source === control.dataset.source) return;
  state.source = control.dataset.source;
  document.querySelectorAll('[data-source]').forEach(node => node.setAttribute('aria-pressed', String(node === control)));
  const search = state.source === 'search';
  $('#keyword').value = ''; $('#keyword').maxLength = search ? 20 : 100;
  $('#keyword').placeholder = search ? '搜索技能或经历，例如：React（最多 20 字）' : '输入岗位关键词，例如：前端工程师';
  $('label[for=keyword]').textContent = search ? '搜索关键词' : '岗位关键词';
  resetResults(); $('#list-source').textContent = search ? '关键词搜索' : '岗位推荐';
  notice('来源已切换，点击“加载候选人”读取对应列表。');
}));
$('#query').addEventListener('submit', async event => {
  event.preventDefault(); if (state.view === 'local') { state.localOffset = 0; await loadLocal(); return; } if (state.busy || state.remoteBusy || !state.csrf) return;
  resetResults();
  try {
    const result = await command({ command: state.source, keyword: $('#keyword').value.trim(), ...(state.source==='search' && state.searchFilters?{filters:state.searchFilters}:{}) }, '正在读取 Boss 候选人，请保持浏览器页面不变…');
    views.online.result = result;
    views.online.selected = result.candidates.length ? 0 : -1;
    if (state.view !== 'online') return;
    renderList(); renderDetail();
    notice(`已读取 ${state.result.candidates.length} 位候选人 · ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 更新。选择候选人查看简介。`);
  } catch (e) { showError(e); notice(e.code === 'BUSY' ? '本次查询未执行，等待当前操作结束后再加载。' : '列表未加载成功，请查看下方具体错误。'); }
});
$('#login').addEventListener('click', async () => {
  views.online = createViewState();
  if (state.view === 'online') resetResults();
  try {
    await command({ command: 'login' }, '正在打开 Boss 登录页…');
    notice('登录页已打开。请在 Chrome 中手动扫码/验证，完成后回到这里加载候选人。');
  } catch (e) { showError(e); notice('登录页未打开成功，请检查错误信息。'); }
});
let localRequestSequence = 0;
async function loadLocal() {
  const requestSequence = ++localRequestSequence;
  try {
    const response = await fetch(`/api/local?q=${encodeURIComponent($('#keyword').value.trim())}&offset=${state.localOffset}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    if (state.view !== 'local' || requestSequence !== localRequestSequence) return;
    resetResults(); state.result = result;
    // 本地记录以本地 ID 作为界面键；不使用会随在线状态变化的 token。
    result.candidates.forEach(candidate => { candidate.token = candidate.localId; if (candidate.imageUrl) state.images.set(candidate.token, candidate.imageUrl); });
    state.selected = result.candidates.length ? 0 : -1;
    renderList(); renderDetail();
    $('#local-page').textContent = `${result.total} 位 · 第 ${Math.floor(state.localOffset / 100) + 1} 页`;
    $('#local-prev').dataset.unavailable = String(state.localOffset === 0);
    $('#local-next').dataset.unavailable = String(state.localOffset + 100 >= result.total);
    $('#error').hidden = true;
    notice('本地资料可直接查看，不会打开 Boss 页面。'); syncBusy();
  } catch (error) { showError(error); }
}
document.querySelectorAll('[data-view]').forEach(control => control.addEventListener('click', async () => {
  if (state.view === control.dataset.view) return;
  views[state.view].keyword = $('#keyword').value;
  state.view = control.dataset.view;
  document.querySelectorAll('[data-view]').forEach(node => node.setAttribute('aria-pressed', String(node === control)));
  const local = state.view === 'local';
  $('.sources').hidden = local; $('#collection-actions').hidden = local; $('#local-pager').hidden = !local; $('#feishu-actions').hidden = !local;
  $('#keyword').value = views[state.view].keyword; $('#keyword').maxLength = local ? 100 : state.source === 'search' ? 20 : 100;
  $('#keyword').placeholder = local ? '查询本地姓名、技能或经历' : state.source === 'search' ? '搜索技能或经历' : '输入岗位关键词';
  $('label[for=keyword]').textContent = local ? '查询本地候选人' : '在线候选人关键词';
  $('#error').hidden = true;
  if (local) { resetResults(); $('#list-source').textContent = '正在读取本地数据'; }
  else if (state.result) { renderList(); renderDetail(); } else resetResults();
  syncBusy();
  if (local) await loadLocal();
  else if (state.stale) {
    const error = new Error('Boss 列表已变化，请重新加载候选人。'); error.code = 'STALE_LIST'; showError(error);
    notice('已保留上次列表，但它已失效，请重新加载后再打开新简历。');
  } else notice(state.result ? '已恢复上次在线列表、选中候选人和详情页签，未重新请求 Boss。' : '加载列表后会自动保存简介；查看简历后会更新本地简历。');
}));
$('#local-prev').addEventListener('click', () => { state.localOffset -= 100; void loadLocal(); });
$('#local-next').addEventListener('click', () => { state.localOffset += 100; void loadLocal(); });
async function batchRequest(path, payload) {
  const response = await fetch(path, { method:'POST', headers:{'Content-Type':'application/json','X-Boss-Token':state.csrf}, body:JSON.stringify(payload) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}
$('#collect').addEventListener('click', async () => {
  if (!$('#collect-limit').reportValidity()) return;
  const limit = Number($('#collect-limit').value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) { showError(new Error('采集数量必须是 1–500 的整数。')); return; }
  state.busy = true; syncBusy(); $('#error').hidden = true;
  try {
    resetResults();
    await batchRequest('/api/batch', {source:state.source,keyword:$('#keyword').value.trim(),limit,...(state.source==='search'&&state.searchFilters?{filters:state.searchFilters}:{})});
    notice('已开始采集。可以切换到本地候选人库查看已保存的资料。');
  } catch (error) { showError(error); }
  finally { state.busy = false; syncBusy(); }
});
$('#stop-batch').addEventListener('click', async () => {
  try { const result = await batchRequest('/api/batch/stop', {}); notice(result.message); }
  catch (error) { showError(error); }
});
function renderBatch() {
  const batch = state.batch;
  $('#batch-panel').hidden = !batch;
  if (!batch) return;
  const labels = { running:'正在采集', complete:'采集完成', stopped:'已停止采集', failed:'采集已停止：发生错误' };
  $('#batch-title').textContent = `${labels[batch.status]} · 新增简历 ${batch.completed} / ${batch.total} · 跳过已有 ${batch.skipped ?? 0} · 失败跳过 ${(batch.failures ?? []).length} · 列表刷新 ${batch.refreshCount ?? 0} 次`;
  $('#batch-detail').textContent = batch.error || batch.progressMessage || (batch.phase === 'list' ? '正在读取并保存当前列表' : batch.phase === 'retrying' ? `${batch.current} 的简历未打开，等待至 ${new Date(batch.nextAt).toLocaleTimeString('zh-CN')} 重新读取列表后重试（第 ${batch.retry} / 2 次重试）` : batch.phase === 'scrolling' ? '正在向下滚动，加载更多候选人…' : batch.phase === 'waiting' ? `下一位：${batch.current} · 等待至 ${new Date(batch.nextAt).toLocaleTimeString('zh-CN')}` : batch.phase === 'preview' ? `正在打开 ${batch.current} 的简历，完成后保存` : '已成功采集的资料保留在本地候选人库。');
  $('#batch-progress').max = Math.max(1,batch.total); $('#batch-progress').value = batch.completed;
  $('#stop-batch').hidden = batch.status !== 'running';
  const failures = batch.failures ?? [];
  $('#batch-failures').hidden = failures.length === 0;
  $('#batch-failures summary').textContent = `${failures.length} 位未采集成功，查看原因（失败不计入目标数量）`;
  $('#batch-failure-list').replaceChildren(...failures.map(item => element('li', '', `${item.name}${item.age === undefined ? '' : ` · ${item.age} 岁`}：${item.reason}`)));

}
const events = new EventSource('/api/events');
events.onmessage = event => {
  const session = JSON.parse(event.data);
  const wasBusy = state.remoteBusy;
  state.csrf = session.csrf;
  state.remoteBusy = session.busy;
  state.batch = session.batch ?? null;
  renderBatch();
  renderFeishu(session.feishuSync);
  $('#connection').textContent = '本地服务已连接';
  $('.dot').classList.add('ready');
  syncBusy();
  if (!state.busy && session.busy && session.operation.command !== 'batch') {
    const names = { login: '打开 Boss 登录页', recommend: '读取岗位推荐', search: '搜索候选人', preview: '读取完整简历', 'search-filters':'读取 Boss 筛选条件', feishu: '同步本地数据到飞书' };
    notice(`正在${names[session.operation.command]}，请等待完成。`, true);
  } else if (!state.busy && wasBusy) {
    notice('上一项操作已结束，可以加载候选人。');
  }
};
events.onerror = () => {
  events.close();
  state.csrf = '';
  syncBusy();
  $('#connection').textContent = '连接已断开';
  $('.dot').classList.remove('ready');
  showError(new Error('本地服务状态连接已断开，请刷新页面重新连接。'));
};

function renderFeishu(sync) {
  const node = $('#feishu-status'); node.hidden = !sync;
  $('#sync-feishu').textContent = sync?.status === 'running' ? '正在同步到飞书…' : '一键同步到飞书';
  if (!sync) return;
  const label = {running:'正在同步',complete:'同步完成',failed:'同步已停止'}[sync.status];
  node.textContent = `${label} · 新增 ${sync.completed} · 跳过已有 ${sync.skipped} · 有简历 ${sync.total} 条 · 无简历不上传 ${sync.withoutResume ?? 0} 条。${sync.error || sync.phase}${sync.status === 'failed' ? ' 已成功同步的数据保留；处理错误后可再次点击同步。' : ''}`;
  node.classList.toggle('sync-failed', sync.status === 'failed');
}
$('#sync-feishu').addEventListener('click', async () => {
  if (state.busy || state.remoteBusy) return;
  state.busy = true; syncBusy(); $('#error').hidden = true;
  try { renderFeishu(await batchRequest('/api/feishu/sync', {})); }
  catch (error) { showError(error); }
  finally { state.busy = false; syncBusy(); }
});

let filterSchema=[];
$('#open-search-filters').addEventListener('click',async()=>{
  $('#search-filter-dialog').showModal();$('#filter-error').hidden=true;
  $('#search-filter-fields').replaceChildren(element('p','saved-meta','正在读取 Boss 搜索页的筛选选项…'));
  $('#submit-search-filters').dataset.unavailable='true';
  try {
    const data=await command({command:'search-filters'},'正在读取 Boss 筛选条件…');
    views.online.stale=true;
    if(state.view==='online')renderDetail();
    notice('筛选选项已读取，选择条件后点击“应用并搜索”。');
    filterSchema=data.groups;
    $('#filter-context').textContent=`当前 Boss 岗位：${data.job || '未选择'} · 关键词：${data.keyword || '未输入'}`;
    $('#search-filter-fields').replaceChildren(...filterSchema.map(group=>{
      const field=element('fieldset');field.append(element('legend','',group.label));
      const options=element('div','filter-options');
      const selected=state.searchFilters ? (group.multiple?state.searchFilters[group.key]:[state.searchFilters[group.key]]) : group.selected;
      for(const option of group.options){
        const label=element('label','filter-option');const input=document.createElement('input');
        input.type=group.multiple?'checkbox':'radio';input.name=group.key;input.value=option;input.checked=selected.includes(option);
        if(!group.multiple)input.required=true;
        label.append(input,document.createTextNode(option));options.append(label);
      }
      field.append(options);return field;
    }));
    $('#submit-search-filters').dataset.unavailable='false';syncBusy();
  }catch(error){$('#filter-error').textContent=error.message;$('#filter-error').hidden=false;$('#search-filter-fields').replaceChildren();}
});
$('#close-search-filters').addEventListener('click',()=>$('#search-filter-dialog').close());
$('#reset-search-filters').addEventListener('click',()=>{
  $('#search-filter-fields').querySelectorAll('input').forEach(input=>{input.checked=input.type==='radio'&&input.value==='不限';});
});
$('#search-filter-form').addEventListener('submit',event=>{
  event.preventDefault();
  if(state.busy||state.remoteBusy)return;
  const form=new FormData(event.currentTarget);
  state.searchFilters=Object.fromEntries(filterSchema.map(group=>[group.key,group.multiple?form.getAll(group.key):form.get(group.key)]));
  $('#search-filter-summary').textContent=filterSchema.map(group=>`${group.label}：${(group.multiple?state.searchFilters[group.key].join('、'):state.searchFilters[group.key])||'不限'}`).join(' · ');
  $('#search-filter-dialog').close();$('#query').requestSubmit();
});
