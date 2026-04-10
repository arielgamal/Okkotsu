// ── Estado ────────────────────────────────────────────────────────────────
let pipelineName = '';
let steps        = [];
let requests     = [];
let recording    = false;

// Step sendo expandido/editado
let expandedIdx  = null;  // índice do step expandido (null = nenhum)

// Adicionando novo step
// { phase: 'type'|'recording'|'crawler-editor'|'parser-editor'|'lista-editor' }
let adding = null;

// Crawler em montagem
let selectedReq = null;
let varMap      = {};

// Parser em montagem
let parser = { name: '', output_file: '', listSelector: '', fields: [] };

// Picker
let pickCallback        = null;
let isPicking           = false;
let pickedFieldSelector = null;

// ── Background port ───────────────────────────────────────────────────────
const port = chrome.runtime.connect({ name: 'sidepanel' });
port.onMessage.addListener(msg => {
  if (msg.action === 'newRequest')      addRequest(msg.request);
  if (msg.action === 'recordingStatus') setRecording(msg.recording);
  if (msg.action === 'picked')          onPicked(msg.selector);
  if (msg.action === 'pickedCancel')    onPicked(null);
});

// ── Init ──────────────────────────────────────────────────────────────────
chrome.storage.local.get('okkotsu2', data => {
  if (data.okkotsu2) {
    steps        = data.okkotsu2.steps        || [];
    requests     = data.okkotsu2.requests     || [];
    pipelineName = data.okkotsu2.pipelineName || '';
  }
  document.getElementById('sku-input').value = pipelineName;
  updateExportBtn();
  render();
});

function saveState() {
  chrome.storage.local.set({ okkotsu2: { steps, requests, pipelineName } });
}

// ── Header ────────────────────────────────────────────────────────────────
document.getElementById('sku-input').addEventListener('input', e => {
  pipelineName = e.target.value;
  saveState();
});
document.getElementById('btn-export').addEventListener('click', exportPipeline);

function updateExportBtn() {
  document.getElementById('btn-export').disabled = !steps.length;
}

// ── Render ────────────────────────────────────────────────────────────────
function render() {
  const c = document.getElementById('content');
  let html = '';

  // Steps existentes
  steps.forEach((step, idx) => {
    html += renderStepCard(step, idx);
  });

  // Área de adicionar novo step
  html += renderAddArea();

  c.innerHTML = html;
  bindAll();
  updateExportBtn();
}

// ── Step card ─────────────────────────────────────────────────────────────
function renderStepCard(step, idx) {
  const expanded = expandedIdx === idx;
  const badge    = stepBadge(step.type);
  const summary  = stepSummary(step);

  return `
    <div class="step-card ${expanded ? 'expanded' : ''}" data-idx="${idx}">
      <div class="step-header" data-toggle="${idx}">
        <span class="step-idx">${idx}</span>
        <div class="step-info">
          <span class="step-name">${esc(step.name)}</span>
          <span class="step-summary">${summary}</span>
        </div>
        <span class="step-type-badge ${badge.cls}">${badge.label}</span>
        <span class="step-chevron">▼</span>
        <button class="btn-del-step" data-del="${idx}" title="Remover">×</button>
      </div>
      ${expanded ? `<div class="step-body">${renderStepBody(step, idx)}</div>` : ''}
    </div>
  `;
}

function stepBadge(type) {
  if (type === 'crawler') return { cls: 'badge-crawler', label: '📡 crawler' };
  if (type === 'parser')  return { cls: 'badge-parser',  label: '⬡ parser'  };
  return { cls: 'badge-lista', label: '☰ lista' };
}

function stepSummary(step) {
  if (step.type === 'crawler') {
    return `${step.method} ${shortenUrl(step.url)}`;
  }
  if (step.type === 'parser') {
    const names = (step.fields || []).map(f => f.name).join(', ');
    return names || 'sem campos';
  }
  return '';
}

function renderStepBody(step) {
  if (step.type === 'crawler') return renderCrawlerBody(step);
  if (step.type === 'parser')  return renderParserBody(step);
  return '';
}

function renderCrawlerBody(step) {
  return `
    <div class="detail-box">
      <div class="detail-url">${esc(step.url)}</div>
      <div class="detail-meta">
        <span class="method ${step.method.toLowerCase()}">${step.method}</span>
        <span class="status">${step.statusCode || ''}</span>
      </div>
    </div>
    ${Object.keys(step.data || {}).length ? `
    <div class="section-label">Parâmetros</div>
    <table class="data-table">
      <thead><tr><th>Campo</th><th>Valor</th></tr></thead>
      <tbody>
        ${Object.entries(step.data).map(([k, v]) => `
          <tr>
            <td class="field-key">${esc(k)}</td>
            <td class="field-val" title="${esc(String(v))}">${esc(trunc(String(v), 30))}</td>
          </tr>`).join('')}
      </tbody>
    </table>` : ''}
  `;
}

function renderParserBody(step) {
  const fields = step.fields || [];
  return `
    <div style="display:flex;flex-direction:column;gap:3px">
      ${fields.map(f => `
        <div class="field-item">
          <span class="fi-type ${f.value ? 'ft-computed' : 'ft-' + f.type.replace('Field','').toLowerCase()}">${f.value ? 'Calc' : f.type.replace('Field','')}</span>
          <div class="fi-info">
            <span class="fi-name">${esc(f.name)}</span>
            <span class="fi-sel">${esc(f.value || f.css_selector || f.json_path || '')}</span>
          </div>
        </div>`).join('')}
    </div>
  `;
}

// ── Adicionar step ────────────────────────────────────────────────────────
function renderAddArea() {
  if (!adding) {
    return `
      <div class="add-step-area">
        <button class="btn-add-step-main" id="btn-start-add">+ Adicionar step</button>
      </div>`;
  }

  if (adding.phase === 'type') {
    return `
      <div class="add-step-area">
        <div class="type-selector">
          <button class="btn-type" id="btn-type-crawler">
            <span class="type-icon">📡</span>
            <div><span class="type-label">Requisição</span><span class="type-desc">Grave e use uma requisição HTTP</span></div>
          </button>
          <button class="btn-type" id="btn-type-parser">
            <span class="type-icon">⬡</span>
            <div><span class="type-label">Parser</span><span class="type-desc">Extraia valores do HTML ou JSON</span></div>
          </button>
          <button class="btn-type" id="btn-type-lista">
            <span class="type-icon">☰</span>
            <div><span class="type-label">Lista</span><span class="type-desc">Itere sobre múltiplos elementos</span></div>
          </button>
          <button class="btn-back" id="btn-cancel-add">Cancelar</button>
        </div>
      </div>`;
  }

  if (adding.phase === 'recording') {
    const visible = getFilteredReqs();
    const empty   = recording ? 'Aguardando requisições…' : '⏺ Clique em Gravar';
    return `
      <div class="add-step-area">
        <div class="rec-toolbar">
          <button class="btn-back" id="btn-cancel-add">← Voltar</button>
          <button class="btn-rec ${recording ? 'recording' : ''}" id="btn-rec">
            ${recording ? '⏹ Parar' : '⏺ Gravar'}
          </button>
          <button class="btn-sm" id="btn-clear-reqs">Limpar</button>
        </div>
        <input class="filter-input" id="filter" type="text" placeholder="Filtrar URL…">
        <div id="req-list">
          ${visible.length ? visible.map(tmplReqItem).join('') : `<div class="list-empty">${empty}</div>`}
        </div>
      </div>`;
  }

  if (adding.phase === 'crawler-editor') {
    const req     = selectedReq;
    const stepNum = steps.length;
    const hasData = req && Object.keys(req.data || {}).length > 0;
    return `
      <div class="add-step-area">
        <button class="btn-back" id="btn-back-to-recording">← Requisições</button>
        ${req ? `
          <div class="detail-box" style="margin-top:8px">
            <div class="detail-url" title="${esc(req.url)}">${esc(req.baseUrl)}</div>
            <div class="detail-meta">
              <span class="method ${req.method.toLowerCase()}">${req.method}</span>
              <span class="status">${req.statusCode}</span>
              <span class="req-time">${req.time}</span>
            </div>
          </div>` : ''}
        <div class="form-group">
          <label>Nome do step</label>
          <input type="text" id="step-name" value="step_${stepNum}">
        </div>
        ${hasData ? `
          <div class="section-label">Parâmetros</div>
          <table class="data-table">
            <thead><tr><th>Campo</th><th>Valor</th><th>Var?</th><th>Nome da variável</th></tr></thead>
            <tbody id="data-tbody"></tbody>
          </table>` : ''}
        <div class="form-group">
          <label>Salvar conteúdo em arquivo <span class="hint">(opcional)</span></label>
          <input type="text" id="save-content" placeholder="ex: pagina_{{data_inicial}}">
        </div>
        <button class="btn-primary" id="btn-confirm-crawler">+ Adicionar Step ${stepNum}</button>
        <div class="feedback" id="feedback"></div>
      </div>`;
  }

  if (adding.phase === 'parser-editor' || adding.phase === 'lista-editor') {
    const isList  = adding.phase === 'lista-editor';
    const stepNum = steps.length;
    return `
      <div class="add-step-area">
        <button class="btn-back" id="btn-cancel-add">← Voltar</button>
        <div class="form-group" style="margin-top:8px">
          <label>Nome do step</label>
          <input type="text" id="parser-name" value="${esc(parser.name || (isList ? `lista_${stepNum}` : `parser_${stepNum}`))}">
        </div>
        <div class="form-group">
          <label>Arquivo de saída JSON <span class="hint">(opcional — padrão: nome_do_step.json)</span></label>
          <input type="text" id="parser-output" value="${esc(parser.output_file)}" placeholder="ex: resultado_{{data}}.json">
        </div>
        ${isList ? `
          <div class="section-label">Seletor do item da lista</div>
          <div class="pick-row">
            <input type="text" id="parser-list-sel" value="${esc(parser.listSelector)}" placeholder="ex: .resultado-item">
            <button id="btn-pick-list">⊕ Pick</button>
          </div>
          <div class="pick-hint" id="list-hint"></div>` : ''}
        <div class="section-label">
          Campos
          <button class="btn-sm" id="btn-new-field">+ Campo</button>
        </div>
        <div id="parser-fields"></div>
        <div id="field-form-area"></div>
        <button class="btn-primary" id="btn-confirm-parser">+ Adicionar Step ${stepNum}</button>
        <div class="feedback" id="parser-feedback"></div>
      </div>`;
  }

  return '';
}

// ── Bind all ──────────────────────────────────────────────────────────────
function bindAll() {
  // Toggle expand step
  document.querySelectorAll('[data-toggle]').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.dataset.del !== undefined) return;
      const idx = Number(el.dataset.toggle);
      expandedIdx = expandedIdx === idx ? null : idx;
      render();
    });
  });

  // Deletar step
  document.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      steps.splice(Number(btn.dataset.del), 1);
      if (expandedIdx !== null && expandedIdx >= steps.length) expandedIdx = null;
      saveState(); render();
    });
  });

  // Adicionar step
  document.getElementById('btn-start-add')?.addEventListener('click', () => {
    adding = { phase: 'type' }; render();
  });
  document.getElementById('btn-cancel-add')?.addEventListener('click', () => {
    adding = null; render();
  });

  // Seleção de tipo
  document.getElementById('btn-type-crawler')?.addEventListener('click', () => {
    adding = { phase: 'recording' }; render();
  });
  document.getElementById('btn-type-parser')?.addEventListener('click', () => {
    parser = { name: '', output_file: '', listSelector: '', fields: [] };
    adding = { phase: 'parser-editor' }; render();
  });
  document.getElementById('btn-type-lista')?.addEventListener('click', () => {
    parser = { name: '', output_file: '', listSelector: '', fields: [] };
    adding = { phase: 'lista-editor' }; render();
  });

  bindRecording();
  bindCrawlerEditor();
  bindParserEditor();
}

// ── Gravação ──────────────────────────────────────────────────────────────
function tmplReqItem(req) {
  const err = req.statusCode >= 400;
  return `
    <div class="req-item" data-id="${req.id}">
      <span class="method ${req.method.toLowerCase()}">${req.method}</span>
      <span class="req-path" title="${esc(req.url)}">${shortenUrl(req.url)}</span>
      <span class="status ${err ? 'err' : ''}">${req.statusCode}</span>
      <button class="btn-del" data-del-req="${req.id}">×</button>
    </div>`;
}

function bindRecording() {
  document.getElementById('btn-rec')?.addEventListener('click', toggleRecording);
  document.getElementById('btn-clear-reqs')?.addEventListener('click', () => {
    requests = []; saveState(); render();
  });
  document.getElementById('filter')?.addEventListener('input', () => {
    document.getElementById('req-list').innerHTML =
      getFilteredReqs().map(tmplReqItem).join('') ||
      `<div class="list-empty">${recording ? 'Aguardando…' : '⏺ Clique em Gravar'}</div>`;
    bindReqItems();
  });
  bindReqItems();
}

function bindReqItems() {
  document.querySelectorAll('.req-item').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.dataset.delReq) return;
      selectedReq = requests.find(r => r.id === el.dataset.id) || null;
      varMap = {};
      adding = { phase: 'crawler-editor' };
      render();
    });
  });
  document.querySelectorAll('[data-del-req]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      requests = requests.filter(r => r.id !== btn.dataset.delReq);
      saveState(); render();
    });
  });
}

async function toggleRecording() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  chrome.runtime.sendMessage({ action: recording ? 'stopRecording' : 'startRecording', tabId: tab.id });
}

function setRecording(val) {
  recording = val;
  const btn = document.getElementById('btn-rec');
  if (!btn) return;
  btn.textContent = recording ? '⏹ Parar' : '⏺ Gravar';
  btn.className   = 'btn-rec' + (recording ? ' recording' : '');
}

function addRequest(req) {
  requests.unshift(req);
  saveState();
  if (adding?.phase === 'recording') render();
}

function getFilteredReqs() {
  const f = (document.getElementById('filter')?.value || '').toLowerCase();
  return f ? requests.filter(r => r.url.toLowerCase().includes(f)) : requests;
}

// ── Crawler editor ────────────────────────────────────────────────────────
function bindCrawlerEditor() {
  document.getElementById('btn-back-to-recording')?.addEventListener('click', () => {
    adding = { phase: 'recording' }; render();
  });

  const tbody = document.getElementById('data-tbody');
  if (tbody && selectedReq) {
    for (const [key, value] of Object.entries(selectedReq.data || {})) {
      const str = String(value);
      const row = document.createElement('tr');
      row.innerHTML = `
        <td class="field-key">${esc(key)}</td>
        <td class="field-val" title="${esc(str)}">${esc(trunc(str, 25))}</td>
        <td><input type="checkbox" class="var-check" data-key="${esc(key)}"></td>
        <td><input type="text" class="var-name" data-key="${esc(key)}" placeholder="${esc(key)}" disabled></td>
      `;
      tbody.appendChild(row);
    }
    tbody.querySelectorAll('.var-check').forEach(cb => {
      cb.onchange = () => {
        const ni = tbody.querySelector(`.var-name[data-key="${cb.dataset.key}"]`);
        ni.disabled = !cb.checked;
        if (cb.checked) { ni.value = cb.dataset.key; varMap[cb.dataset.key] = cb.dataset.key; ni.focus(); ni.select(); }
        else delete varMap[cb.dataset.key];
      };
    });
    tbody.querySelectorAll('.var-name').forEach(inp => {
      inp.oninput = () => { if (inp.value.trim()) varMap[inp.dataset.key] = inp.value.trim(); };
    });
  }

  document.getElementById('btn-confirm-crawler')?.addEventListener('click', () => {
    if (!selectedReq) return;
    const stepName    = document.getElementById('step-name')?.value.trim()    || `step_${steps.length}`;
    const saveContent = document.getElementById('save-content')?.value.trim() || '';
    const specData = {}, samples = {};
    for (const [k, v] of Object.entries(selectedReq.data || {})) {
      samples[k]  = v;
      specData[k] = varMap[k] ? `{{${varMap[k]}}}` : v;
    }
    const step = {
      type: 'crawler', name: stepName, activated: true,
      url: selectedReq.baseUrl, method: selectedReq.method,
      headers: selectedReq.headers, statusCode: selectedReq.statusCode,
      contentType: selectedReq.contentType, data: specData, samples,
    };
    if (saveContent) step.save_content = saveContent;
    steps.push(step);
    saveState();
    selectedReq = null; varMap = {}; adding = null;
    expandedIdx = null;
    render();
  });
}

// ── Parser editor ─────────────────────────────────────────────────────────
function bindParserEditor() {
  if (adding?.phase !== 'parser-editor' && adding?.phase !== 'lista-editor') return;
  const isList = adding.phase === 'lista-editor';

  document.getElementById('parser-name')?.addEventListener('input', e => { parser.name = e.target.value; });
  document.getElementById('parser-output')?.addEventListener('input', e => { parser.output_file = e.target.value; });

  const listInp = document.getElementById('parser-list-sel');
  if (listInp) {
    listInp.addEventListener('input', e => { parser.listSelector = e.target.value; testListSel(); });
    document.getElementById('btn-pick-list')?.addEventListener('click', () =>
      startPick(null, sel => {
        parser.listSelector = sel;
        const inp = document.getElementById('parser-list-sel');
        if (inp) inp.value = sel;
        testListSel();
      })
    );
  }

  document.getElementById('btn-new-field')?.addEventListener('click', () => showFieldForm(null));
  document.getElementById('btn-confirm-parser')?.addEventListener('click', () => {
    const name    = document.getElementById('parser-name')?.value.trim()  || `parser_${steps.length}`;
    const out     = document.getElementById('parser-output')?.value.trim() || '';
    const listSel = parser.listSelector.trim();

    if (!parser.fields.length) {
      showFeedback('parser-feedback', 'Adicione pelo menos um campo'); return;
    }
    if (isList && !listSel) {
      showFeedback('parser-feedback', 'Defina o seletor da lista'); return;
    }

    const fields = parser.fields.map(f => {
      const spec = { name: f.name, type: f.type };
      if (f.mode === 'computed') { spec.value = f.value; }
      else if (f.mode === 'css') {
        spec.css_selector = f.css_selector;
        spec.attribute    = f.attribute || null;
      } else { spec.json_path = f.json_path; }
      if (f.regex)               spec.regex               = f.regex;
      if (f.regex_merge)         spec.regex_merge         = f.regex_merge;
      if (f.regex_insensitive)   spec.regex_insensitive   = f.regex_insensitive;
      if (f.regex_match_newline) spec.regex_match_newline = f.regex_match_newline;
      if (f.sample)              spec.sample              = f.sample;
      if (f.emit_event)          spec.emit_event          = f.emit_event;
      if (f.required === false)  spec.required            = false;
      return spec;
    });

    const stepFields = isList
      ? [{ name: 'itens', type: 'ListField', css_selector: listSel, omit_name: true, field: { type: 'DictField', fields } }]
      : fields;

    const step = { type: 'parser', name, activated: true, fields: stepFields };
    if (out) step.output_file = out;

    steps.push(step);
    saveState();
    parser = { name: '', output_file: '', listSelector: '', fields: [] };
    adding = null;
    render();
  });

  renderParserFields();
  if (listInp) testListSel();
}

async function testListSel() {
  const hint = document.getElementById('list-hint');
  if (!hint) return;
  const sel = parser.listSelector.trim();
  if (!sel) { hint.textContent = ''; hint.className = 'pick-hint'; return; }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: s => { try { return document.querySelectorAll(s).length; } catch { return -1; } },
    args: [sel],
  }, results => {
    const count = results?.[0]?.result ?? -1;
    hint.textContent = count < 0 ? '✗ seletor inválido' : count ? `✓ ${count} elemento(s)` : '✗ nenhum elemento';
    hint.className   = 'pick-hint ' + (count > 0 ? 'ok' : 'err');
  });
}

function renderParserFields() {
  const c = document.getElementById('parser-fields');
  if (!c) return;
  if (!parser.fields.length) {
    c.innerHTML = '<div class="list-empty" style="padding:8px 0">Nenhum campo</div>'; return;
  }
  c.innerHTML = '';
  parser.fields.forEach((f, idx) => {
    const isComputed = f.mode === 'computed';
    const sel  = f.css_selector || f.json_path || '';
    const type = f.type.replace('Field', '');
    const item = document.createElement('div');
    item.className = 'field-item';
    item.innerHTML = `
      <span class="fi-type ${isComputed ? 'ft-computed' : 'ft-' + type.toLowerCase()}">${isComputed ? 'Calc' : type}</span>
      <div class="fi-info">
        <span class="fi-name">${esc(f.name)}</span>
        <span class="fi-sel">${esc(trunc(f.value || sel, 40))}</span>
        ${f.regex ? `<span class="fi-regex">/${esc(trunc(f.regex, 20))}/</span>` : ''}
      </div>
      <button class="btn-del" data-edit-field="${idx}" title="Editar">✎</button>
      <button class="btn-del" data-rm-field="${idx}" title="Remover">×</button>
    `;
    item.querySelector(`[data-edit-field]`).onclick  = () => showFieldForm(idx);
    item.querySelector(`[data-rm-field]`).onclick    = () => { parser.fields.splice(idx, 1); renderParserFields(); };
    c.appendChild(item);
  });
}

function showFieldForm(editIdx) {
  pickedFieldSelector = null;
  const ex         = editIdx !== null ? parser.fields[editIdx] : null;
  const isComputed = ex?.mode === 'computed';
  const area       = document.getElementById('field-form-area');
  if (!area) return;

  area.innerHTML = `
    <div class="field-form">
      <div class="ff-title">${ex ? 'Editar campo' : 'Novo campo'}</div>
      <div class="ff-row">
        <div class="form-group">
          <label>Nome</label>
          <input id="ff-name" type="text" value="${esc(ex?.name || '')}" placeholder="ex: titulo">
        </div>
        <div class="form-group" style="width:95px">
          <label>Tipo</label>
          <select id="ff-type">
            ${['TextField','DateTimeField','NumberField'].map(t =>
              `<option ${ex?.type===t?'selected':''} value="${t}">${t.replace('Field','')}</option>`
            ).join('')}
          </select>
        </div>
        <div class="form-group" style="width:80px">
          <label>Modo</label>
          <select id="ff-mode">
            <option value="css"      ${!ex||ex.mode==='css'      ?'selected':''}>CSS</option>
            <option value="json"     ${ex?.mode==='json'         ?'selected':''}>JSON</option>
            <option value="computed" ${isComputed                ?'selected':''}>Calc.</option>
          </select>
        </div>
      </div>

      <div id="ff-selector-area" class="form-group">
        <label id="ff-sel-label">Seletor CSS</label>
        <div class="pick-row">
          <input id="ff-selector" type="text"
            value="${esc(pickedFieldSelector ?? ex?.css_selector ?? ex?.json_path ?? '')}"
            placeholder="ex: h5.title">
          <button id="btn-pick-field">⊕ Pick</button>
          <button id="btn-test-field">Testar</button>
        </div>
        <div class="pick-hint" id="field-test-result"></div>
      </div>

      <div id="ff-computed-area" class="form-group" style="display:none">
        <label>Expressão Python <span class="hint">(ex: {{campo.strip()}})</span></label>
        <input id="ff-value" type="text" value="${esc(ex?.value || '')}" placeholder="ex: {{total | parse_numeric}}">
      </div>

      <div id="ff-extra">
        <div class="ff-row">
          <div class="form-group" id="ff-attr-group">
            <label>Atributo <span class="hint">(ex: href, innerHTML)</span></label>
            <input id="ff-attribute" type="text" value="${esc(ex?.attribute || '')}" placeholder="opcional">
          </div>
          <div class="form-group">
            <label>Regex</label>
            <input id="ff-regex" type="text" value="${esc(ex?.regex || '')}" placeholder="ex: (\\d+)">
          </div>
        </div>
        <div class="ff-flags">
          <label><input type="checkbox" id="ff-regex-merge" ${ex?.regex_merge?'checked':''}> merge</label>
          <label><input type="checkbox" id="ff-regex-i"     ${ex?.regex_insensitive?'checked':''}> insensitive</label>
          <label><input type="checkbox" id="ff-regex-nl"    ${ex?.regex_match_newline?'checked':''}> multiline</label>
          <label><input type="checkbox" id="ff-required"    ${ex?.required!==false?'checked':''}> required</label>
        </div>
        <div class="form-group">
          <label>Sample</label>
          <input id="ff-sample" type="text" value="${esc(ex?.sample||'')}" placeholder="valor de exemplo">
        </div>
      </div>

      <div class="form-group">
        <label><input type="checkbox" id="ff-emit" ${ex?.emit_event?'checked':''}> Emitir evento</label>
        <input id="ff-emit-name" type="text" value="${esc(ex?.emit_event||'')}"
          placeholder="ex: EXPECTED_COLLECTED_DOCUMENTS"
          style="margin-top:4px;${ex?.emit_event?'':'display:none'}">
      </div>

      <div class="ff-actions">
        <button class="btn-confirm" id="btn-ff-ok">${ex ? 'Salvar' : 'Adicionar'}</button>
        <button id="btn-ff-cancel">Cancelar</button>
      </div>
    </div>
  `;

  updateFieldFormVis();
  document.getElementById('ff-mode').onchange   = updateFieldFormVis;
  document.getElementById('ff-emit').onchange   = e => {
    document.getElementById('ff-emit-name').style.display = e.target.checked ? '' : 'none';
  };
  document.getElementById('btn-pick-field').onclick = () => {
    if (document.getElementById('ff-mode').value !== 'css') return;
    startPick(parser.listSelector || null, sel => {
      pickedFieldSelector = sel;
      const inp = document.getElementById('ff-selector');
      if (inp) inp.value = sel;
    });
  };
  document.getElementById('btn-test-field').onclick = () => {
    testFieldSel(document.getElementById('ff-selector').value.trim());
  };
  document.getElementById('btn-ff-ok').onclick     = () => saveField(editIdx);
  document.getElementById('btn-ff-cancel').onclick = () => { pickedFieldSelector = null; area.innerHTML = ''; };
}

function updateFieldFormVis() {
  const mode  = document.getElementById('ff-mode')?.value || 'css';
  const isCss = mode === 'css';
  const isComp = mode === 'computed';

  document.getElementById('ff-selector-area').style.display = isComp ? 'none' : '';
  document.getElementById('ff-computed-area').style.display = isComp ? '' : 'none';
  document.getElementById('ff-extra').style.display         = isComp ? 'none' : '';

  const label   = document.getElementById('ff-sel-label');
  const pickBtn = document.getElementById('btn-pick-field');
  const attrGrp = document.getElementById('ff-attr-group');
  const inp     = document.getElementById('ff-selector');
  if (label)   label.firstChild.textContent = isCss ? 'Seletor CSS' : 'JSON Path';
  if (pickBtn) pickBtn.style.display        = isCss ? '' : 'none';
  if (attrGrp) attrGrp.style.display        = isCss ? '' : 'none';
  if (inp)     inp.placeholder              = isCss ? 'ex: h5.title' : 'ex: data.[*].name';
}

async function testFieldSel(selector) {
  const el = document.getElementById('field-test-result');
  if (!el || !selector) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (sel, ctx) => {
      try {
        const base = ctx ? document.querySelector(ctx) : document;
        const els  = base ? base.querySelectorAll(sel) : [];
        return { count: els.length, samples: Array.from(els).slice(0,2).map(e => e.textContent.trim().slice(0,50)) };
      } catch { return { count: -1, samples: [] }; }
    },
    args: [selector, parser.listSelector || null],
  }, results => {
    const { count, samples } = results?.[0]?.result || { count: -1, samples: [] };
    el.textContent = count < 0 ? '✗ seletor inválido'
      : count ? `✓ ${count} elemento(s): ${samples.map(s=>`"${s}"`).join(' | ')}`
      : '✗ nenhum elemento';
    el.className = 'pick-hint ' + (count > 0 ? 'ok' : 'err');
  });
}

function saveField(editIdx) {
  const name       = document.getElementById('ff-name').value.trim();
  const type       = document.getElementById('ff-type').value;
  const mode       = document.getElementById('ff-mode').value;
  const selector   = document.getElementById('ff-selector')?.value.trim()  || '';
  const value      = document.getElementById('ff-value')?.value.trim()     || '';
  const attribute  = document.getElementById('ff-attribute')?.value.trim() || '';
  const regex      = document.getElementById('ff-regex')?.value.trim()     || '';
  const regexMerge = document.getElementById('ff-regex-merge')?.checked    || false;
  const regexI     = document.getElementById('ff-regex-i')?.checked        || false;
  const regexNl    = document.getElementById('ff-regex-nl')?.checked       || false;
  const required   = document.getElementById('ff-required')?.checked       ?? true;
  const sample     = document.getElementById('ff-sample')?.value.trim()    || null;
  const emitChk    = document.getElementById('ff-emit')?.checked;
  const emitName   = document.getElementById('ff-emit-name')?.value.trim() || '';

  if (!name) { document.getElementById('ff-name').focus(); return; }

  const field = { name, type, mode, required };
  if (mode === 'computed') {
    field.value = value;
  } else if (mode === 'css') {
    field.css_selector = pickedFieldSelector || selector;
    field.attribute    = attribute || null;
  } else {
    field.json_path = selector;
  }
  if (regex)               { field.regex=regex; field.regex_merge=regexMerge; field.regex_insensitive=regexI; field.regex_match_newline=regexNl; }
  if (sample)              field.sample     = sample;
  if (emitChk && emitName) field.emit_event = emitName;

  if (editIdx !== null) parser.fields[editIdx] = field;
  else parser.fields.push(field);

  pickedFieldSelector = null;
  document.getElementById('field-form-area').innerHTML = '';
  renderParserFields();
}

// ── Export ────────────────────────────────────────────────────────────────
function exportPipeline() {
  const name = pipelineName || 'pipeline';
  chrome.runtime.sendMessage({
    action:  'download',
    content: JSON.stringify({ name, version: '1.0', steps }, null, 2),
    filename: `${name}.json`,
  });
}

// ── Picker ────────────────────────────────────────────────────────────────
async function startPick(relativeTo, callback) {
  if (isPicking) return;
  isPicking = true;
  pickCallback = callback;

  const existing = document.querySelector('.picking-indicator');
  if (!existing) {
    const ind = document.createElement('div');
    ind.className = 'picking-indicator';
    ind.textContent = '🎯 Clique em um elemento na página · Esc para cancelar';
    document.getElementById('content').prepend(ind);
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) { isPicking = false; document.querySelector('.picking-indicator')?.remove(); return; }

  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => { window.__okkotsuPickerCleanup?.(); window.__okkotsuPickerActive = false; },
  }, () => {
    chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pickerScript, args: [relativeTo || null] });
  });

  // Safety: reseta isPicking após 30s caso picker não responda
  setTimeout(() => {
    if (isPicking) {
      isPicking = false;
      pickCallback = null;
      document.querySelector('.picking-indicator')?.remove();
    }
  }, 30_000);
}

function onPicked(selector) {
  isPicking = false;
  const cb = pickCallback;
  pickCallback = null;
  document.querySelector('.picking-indicator')?.remove();
  if (cb && selector) cb(selector);
}

function pickerScript(relativeTo) {
  // Limpa qualquer instância anterior antes de iniciar
  window.__okkotsuPickerCleanup?.();
  window.__okkotsuPickerActive = true;

  const hl = document.createElement('div');
  hl.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;background:rgba(14,99,156,.15);border:2px solid #0e639c;box-sizing:border-box;display:none;';
  const lb = document.createElement('div');
  lb.style.cssText = 'position:fixed;z-index:2147483647;background:#0e639c;color:#fff;font:11px/1 monospace;padding:3px 6px;border-radius:2px;pointer-events:none;max-width:90vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:none;';
  document.body.appendChild(hl);
  document.body.appendChild(lb);
  document.body.style.cursor = 'crosshair';

  function getSel(el) {
    if (!el||el===document.body) return 'body';
    if (el.id) return '#'+CSS.escape(el.id);
    const parts=[]; let cur=el;
    while (cur&&cur!==document.documentElement) {
      if (cur.id){parts.unshift('#'+CSS.escape(cur.id));break;}
      let part=cur.tagName.toLowerCase();
      const cls=Array.from(cur.classList||[]).filter(c=>/^[a-z][\w-]*$/i.test(c)&&c.length<40&&!c.match(/\d{3,}/)).slice(0,2);
      if (cls.length) part+='.'+cls.join('.');
      try{if(document.querySelectorAll([part,...parts].join(' > ')).length===1){parts.unshift(part);break;}}catch(_){}
      if (cur.parentElement){const sibs=Array.from(cur.parentElement.children).filter(c=>c.tagName===cur.tagName);if(sibs.length>1)part+=`:nth-child(${sibs.indexOf(cur)+1})`;}
      parts.unshift(part); cur=cur.parentElement;
    }
    return parts.join(' > ');
  }

  function getRelSel(el,ctxSel){
    const ctx=ctxSel?document.querySelector(ctxSel):null;
    if (!ctx) return getSel(el);
    const parts=[]; let cur=el;
    while (cur&&cur!==ctx){
      let part=cur.tagName.toLowerCase();
      const cls=Array.from(cur.classList||[]).filter(c=>/^[a-z][\w-]*$/i.test(c)&&c.length<40&&!c.match(/\d{3,}/)).slice(0,2);
      if(cls.length)part+='.'+cls.join('.');
      if(cur.parentElement&&cur.parentElement!==ctx){const sibs=Array.from(cur.parentElement.children).filter(c=>c.tagName===cur.tagName);if(sibs.length>1)part+=`:nth-child(${sibs.indexOf(cur)+1})`;}
      parts.unshift(part); cur=cur.parentElement;
      if(!cur)return getSel(el);
    }
    return parts.join(' > ')||el.tagName.toLowerCase();
  }

  function onHover(e){
    if(e.target===hl||e.target===lb)return;
    const rect=e.target.getBoundingClientRect();
    const sel=relativeTo?getRelSel(e.target,relativeTo):getSel(e.target);
    Object.assign(hl.style,{display:'block',top:rect.top+'px',left:rect.left+'px',width:rect.width+'px',height:rect.height+'px'});
    Object.assign(lb.style,{display:'block',top:Math.max(0,rect.top-22)+'px',left:rect.left+'px'});
    lb.textContent=sel;
  }
  function onClick(e){
    if(e.target===hl||e.target===lb)return;
    e.preventDefault();e.stopPropagation();
    const sel=relativeTo?getRelSel(e.target,relativeTo):getSel(e.target);
    cleanup();
    chrome.runtime.sendMessage({action:'picked',selector:sel});
  }
  function onKey(e){if(e.key==='Escape'){cleanup();chrome.runtime.sendMessage({action:'pickedCancel'});}}
  function cleanup(){
    window.__okkotsuPickerActive=false;window.__okkotsuPickerCleanup=null;
    hl.remove();lb.remove();document.body.style.cursor='';
    document.removeEventListener('mouseover',onHover,true);
    document.removeEventListener('click',onClick,true);
    document.removeEventListener('keydown',onKey,true);
  }
  window.__okkotsuPickerCleanup=cleanup;
  document.addEventListener('mouseover',onHover,true);
  document.addEventListener('click',onClick,true);
  document.addEventListener('keydown',onKey,true);
}

// ── Helpers ───────────────────────────────────────────────────────────────
function showFeedback(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  setTimeout(() => { if (el) el.textContent = ''; }, 2500);
}
function shortenUrl(url) {
  try { const u=new URL(url); const q=u.search.length>25?u.search.slice(0,25)+'…':u.search; return u.pathname+q; }
  catch { return url.slice(0,55); }
}
function esc(str) {
  return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function trunc(str,n){return String(str||'').length>n?String(str).slice(0,n)+'…':String(str||'');}
