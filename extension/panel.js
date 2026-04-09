// ── Estado ────────────────────────────────────────────────────────────────
let recording  = false;
let requests   = [];   // requisições capturadas
let selectedIdx = null;
let varMap     = {};   // { fieldKey: variableName } para a requisição selecionada
let steps      = [];   // steps adicionados à pipeline

const IGNORED_TYPES = ['image', 'font', 'stylesheet', 'script', 'media', 'websocket', 'ping'];

// ── Init ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-record').addEventListener('click', toggleRecording);
  document.getElementById('btn-clear').addEventListener('click', clearRequests);
  document.getElementById('filter-input').addEventListener('input', renderList);
  document.getElementById('btn-export-pipeline').addEventListener('click', exportPipeline);
  chrome.devtools.network.onRequestFinished.addListener(onRequest);
  renderSteps();
});

// ── Gravação ──────────────────────────────────────────────────────────────
function toggleRecording() {
  recording = !recording;
  const btn = document.getElementById('btn-record');
  btn.textContent = recording ? '⏹ Parar' : '⏺ Gravar';
  btn.classList.toggle('recording', recording);
}

function clearRequests() {
  requests   = [];
  selectedIdx = null;
  varMap     = {};
  renderList();
  document.getElementById('detail').innerHTML =
    '<div class="empty">Selecione uma requisição para configurar o step</div>';
}

// ── Captura ───────────────────────────────────────────────────────────────
function onRequest(entry) {
  if (!recording) return;
  const type = entry._resourceType || '';
  if (IGNORED_TYPES.includes(type)) return;
  const url = entry.request.url;
  if (url.startsWith('chrome-extension://') || url.startsWith('chrome://') || url.startsWith('data:')) return;

  requests.unshift(parseEntry(entry));
  renderList();
}

function parseEntry(entry) {
  const req = entry.request;
  const res = entry.response;

  const headers = {};
  req.headers.forEach(h => { headers[h.name] = h.value; });

  const ct = headers['Content-Type'] || headers['content-type'] || '';
  let data = {};
  let contentType = 'none';

  if (req.postData) {
    if (ct.includes('application/x-www-form-urlencoded')) {
      contentType = 'form';
      if (req.postData.params && req.postData.params.length) {
        req.postData.params.forEach(p => { data[p.name] = p.value || ''; });
      } else if (req.postData.text) {
        try { new URLSearchParams(req.postData.text).forEach((v, k) => { data[k] = v; }); } catch (_) {}
      }
    } else if (ct.includes('application/json')) {
      contentType = 'json';
      try { data = JSON.parse(req.postData.text || '{}'); } catch (_) {}
    } else {
      contentType = 'raw';
      data = { _body: req.postData.text || '' };
    }
  } else if (req.method === 'GET') {
    contentType = 'query';
    try { new URL(req.url).searchParams.forEach((v, k) => { data[k] = v; }); } catch (_) {}
  }

  return {
    id: `req_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    url: req.url,
    baseUrl: req.url.split('?')[0],
    method: req.method,
    headers,
    data,
    contentType,
    statusCode: res.status,
    time: new Date().toLocaleTimeString(),
  };
}

// ── Lista de requisições ──────────────────────────────────────────────────
function renderList() {
  const filter = document.getElementById('filter-input').value.toLowerCase();
  const list   = document.getElementById('request-list');
  list.innerHTML = '';

  const visible = requests
    .map((r, i) => ({ ...r, _idx: i }))
    .filter(r => !filter || r.url.toLowerCase().includes(filter));

  document.getElementById('count-label').textContent =
    `${visible.length} / ${requests.length} requisições`;

  if (!visible.length) {
    list.innerHTML = '<div class="empty-list">Nenhuma requisição capturada</div>';
    return;
  }

  visible.forEach(req => {
    const isErr = req.statusCode >= 400;
    const item  = document.createElement('div');
    item.className = 'req-item' + (req._idx === selectedIdx ? ' selected' : '');
    item.innerHTML = `
      <span class="req-method ${req.method.toLowerCase()}">${req.method}</span>
      <span class="req-path" title="${esc(req.url)}">${shortenUrl(req.url)}</span>
      <span class="req-status${isErr ? ' err' : ''}">${req.statusCode}</span>
      <button class="req-del" title="Remover requisição">×</button>
    `;
    item.addEventListener('click', () => selectRequest(req._idx));
    item.querySelector('.req-del').addEventListener('click', e => deleteRequest(req._idx, e));
    list.appendChild(item);
  });
}

function shortenUrl(url) {
  try {
    const u = new URL(url);
    const q = u.search.length > 20 ? u.search.slice(0, 20) + '…' : u.search;
    return u.pathname + q;
  } catch (_) { return url.slice(0, 50); }
}

// ── Deletar requisição ────────────────────────────────────────────────────
function deleteRequest(idx, event) {
  event.stopPropagation();
  requests.splice(idx, 1);

  if (selectedIdx === idx) {
    selectedIdx = null;
    varMap = {};
    document.getElementById('detail').innerHTML =
      '<div class="empty">Selecione uma requisição para configurar o step</div>';
  } else if (selectedIdx !== null && selectedIdx > idx) {
    selectedIdx--;
  }

  renderList();
}

// ── Selecionar requisição ─────────────────────────────────────────────────
function selectRequest(idx) {
  selectedIdx = idx;
  varMap = {};
  renderList();
  renderDetail(requests[idx]);
}

// ── Painel de detalhe ─────────────────────────────────────────────────────
function renderDetail(req) {
  const detail  = document.getElementById('detail');
  const isErr   = req.statusCode >= 400;
  const hasData = Object.keys(req.data).length > 0;

  detail.innerHTML = `
    <div class="detail-header">
      <div class="detail-url" title="${esc(req.url)}">${esc(req.baseUrl)}</div>
      <div class="detail-meta">
        <span class="req-method ${req.method.toLowerCase()}">${req.method}</span>
        <span class="status-code${isErr ? ' err' : ''}">${req.statusCode}</span>
        <span class="req-time">${req.time}</span>
      </div>
    </div>

    <div class="form-group">
      <label>Nome do step</label>
      <input type="text" id="step-name" placeholder="ex: busca_dou" value="step_${steps.length}">
    </div>

    ${hasData ? `
    <div class="section-title">Dados da requisição</div>
    <table class="data-table">
      <thead>
        <tr>
          <th>Campo</th>
          <th>Valor</th>
          <th>Var?</th>
          <th>Nome da variável</th>
        </tr>
      </thead>
      <tbody id="data-tbody"></tbody>
    </table>
    ` : '<div class="section-title" style="margin-bottom:12px">Sem dados de formulário</div>'}

    <div class="form-group">
      <label>Seletor do botão "Imprimir" <span class="hint">(CSS selector — opcional)</span></label>
      <input type="text" id="print-selector" placeholder="ex: .btn-imprimir">
    </div>

    <div class="form-group">
      <label>Arquivo de saída <span class="hint">(opcional — use {{variavel}})</span></label>
      <input type="text" id="output-file" placeholder="ex: resultado_{{data}}.pdf">
    </div>

    <button class="btn-add-step" id="btn-add-step">+ Adicionar como Step ${steps.length}</button>
    <div class="feedback" id="feedback"></div>
  `;

  document.getElementById('btn-add-step').addEventListener('click', addAsStep);

  if (!hasData) return;

  const tbody = document.getElementById('data-tbody');
  for (const [key, value] of Object.entries(req.data)) {
    const str     = String(value);
    const isLong  = str.length > 80;
    const display = isLong ? str.slice(0, 60) + '…' : str;

    const row = document.createElement('tr');
    row.innerHTML = `
      <td class="field-key">${esc(key)}</td>
      <td class="field-val${isLong ? ' long' : ''}" title="${esc(str)}">${esc(display)}</td>
      <td><input type="checkbox" class="var-check" data-key="${esc(key)}"></td>
      <td><input type="text"     class="var-name"  data-key="${esc(key)}" placeholder="${esc(key)}" disabled></td>
    `;
    tbody.appendChild(row);
  }

  tbody.querySelectorAll('.var-check').forEach(cb => {
    cb.addEventListener('change', () => {
      const key       = cb.dataset.key;
      const nameInput = tbody.querySelector(`.var-name[data-key="${key}"]`);
      nameInput.disabled = !cb.checked;
      if (cb.checked) {
        nameInput.value = key;
        varMap[key] = key;
        nameInput.focus();
        nameInput.select();
      } else {
        delete varMap[key];
      }
    });
  });

  tbody.querySelectorAll('.var-name').forEach(input => {
    input.addEventListener('input', () => {
      if (input.value.trim()) varMap[input.dataset.key] = input.value.trim();
    });
  });
}

// ── Adicionar step ─────────────────────────────────────────────────────────
function buildStep() {
  if (selectedIdx === null) return null;
  const req = requests[selectedIdx];

  const stepName      = (document.getElementById('step-name')?.value || `step_${steps.length}`).trim();
  const printSelector = document.getElementById('print-selector')?.value.trim() || '';
  const outputFile    = document.getElementById('output-file')?.value.trim() || '';

  const specData = {};
  const samples  = {};
  for (const [key, value] of Object.entries(req.data)) {
    samples[key]  = value;
    specData[key] = varMap[key] ? `{{${varMap[key]}}}` : value;
  }

  const step = {
    type:        'crawler',
    url:         req.baseUrl,
    method:      req.method,
    headers:     req.headers,
    statusCode:  req.statusCode,
    contentType: req.contentType,
    data:        specData,
    samples,
    id:          req.id,
    name:        stepName,
    activated:   true,
  };

  if (printSelector) step.print_selector = printSelector;
  if (outputFile)    step.output_file    = outputFile;

  return step;
}

function addAsStep() {
  const step = buildStep();
  if (!step) return;

  steps.push(step);
  renderSteps();
  showFeedback(`✓ Step ${steps.length - 1} adicionado!`);
}

function showFeedback(msg) {
  const el = document.getElementById('feedback');
  if (!el) return;
  el.textContent = msg;
  setTimeout(() => { if (el) el.textContent = ''; }, 2000);
}

// ── Painel de steps ────────────────────────────────────────────────────────
function renderSteps() {
  const list      = document.getElementById('steps-list');
  const countEl   = document.getElementById('steps-count');
  const exportBtn = document.getElementById('btn-export-pipeline');

  countEl.textContent  = steps.length;
  exportBtn.disabled   = steps.length === 0;

  list.innerHTML = '';
  if (!steps.length) {
    list.innerHTML = '<div class="steps-empty">Nenhum step adicionado</div>';
    return;
  }

  steps.forEach((step, idx) => {
    const item = document.createElement('div');
    item.className = 'step-item';
    item.innerHTML = `
      <span class="step-index">${idx}</span>
      <div class="step-info">
        <span class="step-name">${esc(step.name)}</span>
        <span class="step-type">${esc(step.type)}</span>
      </div>
      <button class="step-del" title="Remover step">×</button>
    `;
    item.querySelector('.step-del').addEventListener('click', () => removeStep(idx));
    list.appendChild(item);
  });
}

function removeStep(idx) {
  steps.splice(idx, 1);
  renderSteps();
}

// ── Exportar pipeline ──────────────────────────────────────────────────────
function exportPipeline() {
  if (!steps.length) return;
  const pipelineName = (document.getElementById('pipeline-name').value || 'pipeline').trim();

  const pipeline = {
    name:    pipelineName,
    version: '1.0',
    steps,
  };

  chrome.runtime.sendMessage({
    action:   'download',
    content:  JSON.stringify(pipeline, null, 2),
    filename: `${pipelineName}.json`,
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
