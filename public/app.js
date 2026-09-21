// 页面交互：时区档案与换算台两块都从服务端拉取，任何一步失败都把说明显示在顶部并标到对应输入项上

const state = {
  zones: [],
  allZones: [],
  counts: { total: 0, dstCount: 0, noDstCount: 0 },
  editingId: '',
  lastConvert: null,
};

// 档案表单里正在编辑的年度例外（停行/改期），随表单一起保存
let formExceptions = [];

const MONTHS = [
  ['1', '一月'], ['2', '二月'], ['3', '三月'], ['4', '四月'], ['5', '五月'], ['6', '六月'],
  ['7', '七月'], ['8', '八月'], ['9', '九月'], ['10', '十月'], ['11', '十一月'], ['12', '十二月'],
];
const WEEKS = [['1', '第一个'], ['2', '第二个'], ['3', '第三个'], ['4', '第四个'], ['last', '最后一个']];
const WEEKDAYS = [['0', '周日'], ['1', '周一'], ['2', '周二'], ['3', '周三'], ['4', '周四'], ['5', '周五'], ['6', '周六']];

const el = (id) => document.getElementById(id);

// 统一的请求入口：出错时把服务端给的错误码、说明与出错位置一起抛出去
async function request(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch (err) {
    payload = null;
  }
  if (!res.ok) {
    const error = (payload && payload.error) || {};
    const failure = new Error(error.message || `请求失败（状态码 ${res.status}）`);
    failure.code = error.code || '';
    failure.field = error.field || '';
    throw failure;
  }
  return payload;
}

function notify(message, kind) {
  const box = el('notice');
  box.textContent = message;
  box.className = `notice ${kind === 'ok' ? 'ok' : 'error'}`;
}

function clearNotice() {
  const box = el('notice');
  box.className = 'notice hidden';
  box.textContent = '';
}

function clearFieldMarks() {
  document.querySelectorAll('.invalid').forEach((node) => node.classList.remove('invalid'));
}

function markField(field) {
  if (!field) return;
  // 年度例外的错误字段形如 dstExceptions[2].start.day，统一标到例外编辑框
  if (field.startsWith('dstExceptions')) {
    el('zone-ex-box').classList.add('invalid');
    return;
  }
  const target = document.querySelector(`[data-field="${field}"]`);
  if (!target) return;
  target.classList.add('invalid');
  const input = target.matches('input, select, textarea') ? target : target.querySelector('input, select, textarea');
  if (input) input.focus();
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (num) => String(num).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const MONTH_LABEL = Object.fromEntries(MONTHS);
const WEEK_LABEL = Object.fromEntries(WEEKS);
const WEEKDAY_LABEL = Object.fromEntries(WEEKDAYS);

function ruleText(part) {
  if (!part) return '—';
  const hour = String(part.hour).padStart(2, '0');
  const minute = String(part.minute).padStart(2, '0');
  return `${MONTH_LABEL[String(part.month)] || part.month}${WEEK_LABEL[part.week] || part.week}${WEEKDAY_LABEL[String(part.weekday)] || part.weekday} ${hour}:${minute}`;
}

const OPERATOR_KEY = 'zone-clock-operator';

function currentOperator() {
  return el('operator').value.trim();
}

function restoreOperator() {
  el('operator').value = window.localStorage.getItem(OPERATOR_KEY) || '';
}

async function loadHealth() {
  try {
    await request('/api/health');
    el('health').textContent = '服务正常';
    el('health').className = 'health ok';
  } catch (err) {
    el('health').textContent = '服务连不上';
    el('health').className = 'health bad';
  }
}

function fillOptions() {
  const monthOptions = MONTHS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
  const weekOptions = WEEKS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
  const weekdayOptions = WEEKDAYS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
  ['zone-start-month', 'zone-end-month'].forEach((id) => { el(id).innerHTML = monthOptions; });
  ['zone-start-week', 'zone-end-week'].forEach((id) => { el(id).innerHTML = weekOptions; });
  ['zone-start-weekday', 'zone-end-weekday'].forEach((id) => { el(id).innerHTML = weekdayOptions; });
}

async function loadZones() {
  const params = new URLSearchParams();
  const dst = el('zone-filter-dst').value;
  const keyword = el('zone-filter-keyword').value.trim();
  if (dst) params.set('dst', dst);
  if (keyword) params.set('keyword', keyword);
  const query = params.toString();
  const payload = await request(`/api/zones${query ? `?${query}` : ''}`);
  state.zones = payload.zones || [];
  state.counts = { total: payload.total || 0, dstCount: payload.dstCount || 0, noDstCount: payload.noDstCount || 0 };
  renderZones();
  renderConvertZoneOptions();
  renderScheduleZoneOptions();
  // 筛选结果与全量是两回事：时刻表下拉与按 id 查档案都要用全量
  if (!query) state.allZones = payload.zones || [];
}

// 不带筛选地拉一遍全量档案，专供时刻表下拉与按 id 取显示名
async function loadAllZones() {
  const payload = await request('/api/zones');
  state.allZones = payload.zones || [];
  renderScheduleZoneOptions();
}

function renderZones() {
  el('zone-counts').textContent = `共登记 ${state.counts.total} 条档案，其中实行夏令时 ${state.counts.dstCount} 条，不实行 ${state.counts.noDstCount} 条；当前筛选出 ${state.zones.length} 条`;
  const body = el('zone-body');
  body.innerHTML = state.zones.map((item) => `<tr>
      <td class="mono">${escapeHtml(item.name)}</td>
      <td>${escapeHtml(item.displayName)}</td>
      <td class="mono">${escapeHtml(item.offsetText)}</td>
      <td>${item.usesDst ? '<span class="tag on">实行</span>' : '<span class="tag off">不实行</span>'}</td>
      <td class="mono">${item.dstOffsetText ? escapeHtml(item.dstOffsetText) : '—'}</td>
      <td class="rule-cell">${item.usesDst ? `${escapeHtml(ruleText(item.dstStart))} 起，${escapeHtml(ruleText(item.dstEnd))} 止` : '—'}</td>
      <td class="rule-cell">${exceptionCellHtml(item)}</td>
      <td class="mono">${escapeHtml(item.yearRangeText)}</td>
      <td class="note-cell">${escapeHtml(item.note)}</td>
      <td class="actions">
        ${item.usesDst ? `<button type="button" class="link" data-zone-schedule="${escapeHtml(item.id)}">时刻表</button>` : ''}
        <button type="button" class="link" data-zone-edit="${escapeHtml(item.id)}">编辑</button>
        <button type="button" class="link danger" data-zone-delete="${escapeHtml(item.id)}">删除</button>
      </td>
    </tr>`).join('');
  el('zone-empty').classList.toggle('hidden', state.zones.length > 0);
}

// 年度例外那一列：没例外给一条横线，有例外逐条列明年份与停行或改期
function exceptionCellHtml(item) {
  if (!item.usesDst) return '—';
  const list = Array.isArray(item.dstExceptions) ? item.dstExceptions : [];
  if (!list.length) return '<span class="ex-none">无</span>';
  return list.map((ex) => {
    if (ex.disabled) return `<span class="ex-chip skip">${ex.year} 停行</span>`;
    const p = (point) => `${String(point.month).padStart(2, '0')}-${String(point.day).padStart(2, '0')} ${String(point.hour).padStart(2, '0')}:${String(point.minute).padStart(2, '0')}`;
    return `<span class="ex-chip move">${ex.year} 改期 ${escapeHtml(p(ex.start))} 起／${escapeHtml(p(ex.end))} 止</span>`;
  }).join('<br>');
}

function renderConvertZoneOptions() {
  const select = el('convert-zone');
  const current = select.value;
  select.innerHTML = state.zones
    .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}　${escapeHtml(item.displayName)}</option>`)
    .join('');
  if (state.zones.some((item) => item.id === current)) select.value = current;
}

function renderScheduleZoneOptions() {
  const select = el('schedule-zone');
  const current = select.value;
  select.innerHTML = state.allZones.filter((item) => item.usesDst)
    .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}　${escapeHtml(item.displayName)}</option>`)
    .join('');
  if (state.allZones.some((item) => item.id === current)) select.value = current;
}

async function runSchedule() {
  clearNotice();
  const zoneId = el('schedule-zone').value;
  if (!zoneId) {
    notify('没有实行夏令时的档案可推算时刻表', 'error');
    return;
  }
  const params = new URLSearchParams();
  const from = el('schedule-from-year').value.trim();
  const to = el('schedule-to-year').value.trim();
  if (from) params.set('fromYear', from);
  if (to) params.set('toYear', to);
  try {
    const result = await request(`/api/zones/${encodeURIComponent(zoneId)}/schedule${[...params].length ? `?${params}` : ''}`);
    renderSchedule(result);
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field === 'toYear' ? 'scheduleToYear' : err.field === 'fromYear' ? 'scheduleFromYear' : '');
  }
}

function scheduleBadgeHtml(year) {
  if (year.kind === 'skipped') return '<span class="tag skip">年度例外 · 停行</span>';
  if (year.kind === 'moved') return '<span class="tag ex">年度例外 · 改期</span>';
  if (year.kind === 'rule') return '<span class="tag on">通用规则</span>';
  if (year.kind === 'out') return '<span class="tag off">区间外</span>';
  return '<span class="tag off">—</span>';
}

function renderSchedule(result) {
  const zone = state.allZones.find((item) => item.id === result.zoneId)
    || state.zones.find((item) => item.id === result.zoneId);
  const exNote = result.exceptionYears.length
    ? `；其中 ${result.exceptionYears.join('、')} 年有年度例外，已按例外推算并标出`
    : '';
  el('schedule-meta').textContent = `${result.zoneName}（${zone ? zone.displayName : ''}）${result.fromYear} 至 ${result.toYear} 年的夏令时切换时刻表${exNote}`;
  const body = el('schedule-body');
  body.innerHTML = result.years.map((year) => {
    const rowClass = year.kind === 'skipped' || year.kind === 'moved' ? 'exception-row' : '';
    return `<tr class="${rowClass}">
      <td class="mono">${year.year}</td>
      <td>${scheduleBadgeHtml(year)}</td>
      <td class="mono">${escapeHtml(year.startText || '—')}</td>
      <td class="mono">${escapeHtml(year.endText || '—')}</td>
      <td class="rule-cell">${escapeHtml(year.summary)}${year.exceptionNote ? `（${escapeHtml(year.exceptionNote)}）` : ''}</td>
    </tr>`;
  }).join('');
  el('schedule-empty').classList.toggle('hidden', result.years.length > 0);
}

// 一条改期例外的月日时分输入项；开始默认三月一日，结束默认十一月一日
function pointInputs(prefix, point) {
  const fallback = prefix.startsWith('ex-start') ? { month: 3, day: 1, hour: 0, minute: 0 } : { month: 11, day: 1, hour: 0, minute: 0 };
  const p = point || fallback;
  return `<label>月<input type="number" min="1" max="12" data-ex="${prefix}-month" value="${p.month}"></label>
    <label>日<input type="number" min="1" max="31" data-ex="${prefix}-day" value="${p.day}"></label>
    <label>时<input type="number" min="0" max="23" data-ex="${prefix}-hour" value="${p.hour}"></label>
    <label>分<input type="number" min="0" max="59" data-ex="${prefix}-minute" value="${p.minute}"></label>`;
}

// 把表单里例外行当前的内容收回到 formExceptions
function syncExceptionRow(index) {
  const item = formExceptions[index];
  if (!item) return;
  item.year = Number(el(`ex-year-${index}`).value);
  item.disabled = el(`ex-kind-${index}`).value === 'skip';
  if (!item.disabled) {
    item.start = {
      month: Number(el(`ex-start-month-${index}`).value),
      day: Number(el(`ex-start-day-${index}`).value),
      hour: Number(el(`ex-start-hour-${index}`).value),
      minute: Number(el(`ex-start-minute-${index}`).value),
    };
    item.end = {
      month: Number(el(`ex-end-month-${index}`).value),
      day: Number(el(`ex-end-day-${index}`).value),
      hour: Number(el(`ex-end-hour-${index}`).value),
      minute: Number(el(`ex-end-minute-${index}`).value),
    };
  }
  const noteEl = el(`ex-note-${index}`);
  if (noteEl) item.note = noteEl.value;
}

function renderExceptionRows() {
  const box = el('zone-ex-rows');
  box.innerHTML = formExceptions.map((ex, index) => {
    const moveFields = ex.disabled ? '' : `
      <div class="ex-points">
        <div class="ex-point"><span class="ex-point-label">开始</span>${pointInputs(`ex-start-${index}`, ex.start)}</div>
        <div class="ex-point"><span class="ex-point-label">结束</span>${pointInputs(`ex-end-${index}`, ex.end)}</div>
      </div>`;
    return `<div class="ex-row" data-ex-row="${index}">
      <label>年份<input type="number" min="1900" max="2100" id="ex-year-${index}" value="${ex.year}"></label>
      <label>这一年
        <select id="ex-kind-${index}">
          <option value="skip"${ex.disabled ? ' selected' : ''}>停行夏令时</option>
          <option value="move"${ex.disabled ? '' : ' selected'}>改期（另定起止）</option>
        </select>
      </label>
      ${moveFields}
      <label class="ex-note">备注<input type="text" id="ex-note-${index}" maxlength="100" value="${escapeHtml(ex.note || '')}"></label>
      <button type="button" class="link danger" data-ex-remove="${index}">删除这条</button>
    </div>`;
  }).join('');
}

// 输入变化时先收回当前行，再决定要不要按"停行/改期"重绘该行的字段
function refreshExceptionRowFields(index) {
  syncExceptionRow(index);
  renderExceptionRows();
}

function openZoneForm(zone) {
  state.editingId = zone ? zone.id : '';
  formExceptions = zone && Array.isArray(zone.dstExceptions)
    ? JSON.parse(JSON.stringify(zone.dstExceptions))
    : [];
  el('zone-form-title').textContent = zone ? `编辑档案：${zone.name}` : '新建档案';
  el('zone-name').value = zone ? zone.name : '';
  el('zone-display').value = zone ? zone.displayName : '';
  el('zone-offset').value = zone ? String(zone.offsetMinutes) : '';
  el('zone-uses-dst').checked = zone ? zone.usesDst : false;
  el('zone-dst-offset').value = zone && zone.dstOffsetMinutes !== null ? String(zone.dstOffsetMinutes) : '';
  const start = zone && zone.dstStart ? zone.dstStart : { month: 3, week: '2', weekday: 0, hour: 2, minute: 0 };
  const end = zone && zone.dstEnd ? zone.dstEnd : { month: 11, week: '1', weekday: 0, hour: 2, minute: 0 };
  el('zone-start-month').value = String(start.month);
  el('zone-start-week').value = start.week;
  el('zone-start-weekday').value = String(start.weekday);
  el('zone-start-hour').value = String(start.hour);
  el('zone-start-minute').value = String(start.minute);
  el('zone-end-month').value = String(end.month);
  el('zone-end-week').value = end.week;
  el('zone-end-weekday').value = String(end.weekday);
  el('zone-end-hour').value = String(end.hour);
  el('zone-end-minute').value = String(end.minute);
  el('zone-from-year').value = zone ? String(zone.fromYear) : '';
  el('zone-to-year').value = zone && zone.toYear !== null ? String(zone.toYear) : '';
  el('zone-note').value = zone ? zone.note : '';
  renderExceptionRows();
  toggleExceptionBox();
  el('zone-form').classList.remove('hidden');
  el('zone-name').focus();
}

function toggleExceptionBox() {
  el('zone-ex-box').style.display = el('zone-uses-dst').checked ? '' : 'none';
}

function closeZoneForm() {
  state.editingId = '';
  formExceptions = [];
  el('zone-form').classList.add('hidden');
  clearFieldMarks();
}

async function submitZone(event) {
  event.preventDefault();
  clearNotice();
  clearFieldMarks();
  const payload = {
    name: el('zone-name').value,
    displayName: el('zone-display').value,
    offsetMinutes: el('zone-offset').value,
    usesDst: el('zone-uses-dst').checked,
    dstOffsetMinutes: el('zone-dst-offset').value === '' ? null : el('zone-dst-offset').value,
    dstStart: {
      month: el('zone-start-month').value,
      week: el('zone-start-week').value,
      weekday: el('zone-start-weekday').value,
      hour: el('zone-start-hour').value,
      minute: el('zone-start-minute').value,
    },
    dstEnd: {
      month: el('zone-end-month').value,
      week: el('zone-end-week').value,
      weekday: el('zone-end-weekday').value,
      hour: el('zone-end-hour').value,
      minute: el('zone-end-minute').value,
    },
    fromYear: el('zone-from-year').value,
    toYear: el('zone-to-year').value === '' ? null : el('zone-to-year').value,
    note: el('zone-note').value,
  };
  if (!payload.usesDst) {
    payload.dstOffsetMinutes = null;
    payload.dstStart = null;
    payload.dstEnd = null;
    payload.dstExceptions = [];
  } else {
    // 保存前把每条例外行的输入收回内存；停行的不带上起止
    formExceptions.forEach((_, index) => syncExceptionRow(index));
    payload.dstExceptions = formExceptions.map((ex) => (ex.disabled
      ? { year: ex.year, disabled: true, note: ex.note || '' }
      : { year: ex.year, disabled: false, start: ex.start, end: ex.end, note: ex.note || '' }));
  }
  const editing = state.editingId;
  try {
    if (editing) {
      await request(`/api/zones/${encodeURIComponent(editing)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      notify('时区档案已保存', 'ok');
    } else {
      await request('/api/zones', { method: 'POST', body: JSON.stringify(payload) });
      notify('时区档案已新增', 'ok');
    }
    closeZoneForm();
    await loadZones();
    await loadAllZones();
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

async function runConvert() {
  clearNotice();
  const payload = {
    date: el('convert-date').value,
    time: el('convert-time').value,
    zoneId: el('convert-zone').value,
  };
  try {
    const result = await request('/api/convert', { method: 'POST', body: JSON.stringify(payload) });
    state.lastConvert = result;
    renderConvert(result);
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

function renderConvert(result) {
  const exceptionNote = result.exceptionCount > 0
    ? `；其中 ${result.exceptionCount} 条结果落在年度例外年份，已按例外换算并标出`
    : '';
  el('convert-meta').textContent = `来源 ${result.input.zoneName}（${result.input.zoneDisplayName}，${result.input.offsetText}，${result.input.dstBasisText}）的 ${result.input.date} ${result.input.time}，换算时刻 ${formatTime(result.convertedAt)}；参与换算的档案 ${result.zonesInScope} 条，与来源不同天的有 ${result.crossDayCount} 条，最大时差 ${Math.floor(result.maxDiffMinutes / 60)} 小时 ${result.maxDiffMinutes % 60} 分${exceptionNote}`;
  const body = el('convert-body');
  body.innerHTML = result.results.map((item) => `<tr class="${item.isSource ? 'source-row' : ''}">
      <td class="mono">${escapeHtml(item.name)}</td>
      <td>${escapeHtml(item.displayName)}</td>
      <td class="mono">${escapeHtml(item.localDate)}</td>
      <td class="mono">${escapeHtml(item.localTime)}</td>
      <td>${escapeHtml(item.weekday)}</td>
      <td><span class="tag ${item.dayOffset === 0 ? 'off' : 'warn'}">${escapeHtml(item.dayOffsetText)}</span></td>
      <td class="mono">${escapeHtml(item.offsetText)}</td>
      <td>${escapeHtml(item.diffText)}</td>
      <td>${dstBasisHtml(item)}</td>
    </tr>`).join('');
  el('convert-empty').classList.toggle('hidden', result.results.length > 0);
}

// 夏令时那一列：走通用规则与走年度例外要一眼分得开
function dstBasisHtml(item) {
  if (!item.usesDst) return '<span class="tag off">不实行</span>';
  if (item.dstKind === 'rule') return '<span class="tag on">夏令时 · 通用规则</span>';
  if (item.dstKind === 'moved') return '<span class="tag ex">夏令时 · 例外改期</span>';
  if (item.dstKind === 'skipped') return '<span class="tag skip">标准 · 例外停行</span>';
  return '<span class="tag off">标准时间</span>';
}

// 列表上的操作用事件委托统一处理，列表重绘之后不需要重新绑定
document.addEventListener('click', async (event) => {
  const node = event.target.closest('button');
  if (!node) return;

  if (node.dataset.zoneSchedule) {
    clearNotice();
    el('schedule-zone').value = node.dataset.zoneSchedule;
    const nowYear = new Date().getFullYear();
    if (!el('schedule-from-year').value) el('schedule-from-year').value = String(nowYear - 2);
    if (!el('schedule-to-year').value) el('schedule-to-year').value = String(nowYear + 3);
    runSchedule();
    document.getElementById('schedule-body').scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  if (node.dataset.zoneEdit) {
    clearNotice();
    const found = state.zones.find((item) => item.id === node.dataset.zoneEdit);
    if (found) openZoneForm(found);
    return;
  }

  if (node.dataset.zoneDelete) {
    clearNotice();
    const found = state.allZones.find((item) => item.id === node.dataset.zoneDelete)
      || state.zones.find((item) => item.id === node.dataset.zoneDelete);
    if (!window.confirm(`确定删除 ${found ? found.name : ''} 这条档案吗？`)) return;
    try {
      await request(`/api/zones/${encodeURIComponent(node.dataset.zoneDelete)}`, { method: 'DELETE' });
      if (state.editingId === node.dataset.zoneDelete) closeZoneForm();
      notify('时区档案已删除', 'ok');
      await loadZones();
      await loadAllZones();
    } catch (err) {
      notify(err.message, 'error');
    }
  }
});

el('zone-form').addEventListener('submit', submitZone);
el('zone-uses-dst').addEventListener('change', toggleExceptionBox);
el('zone-ex-add').addEventListener('click', () => {
  formExceptions.forEach((_, index) => syncExceptionRow(index));
  const year = Number(el('zone-from-year').value) || new Date().getFullYear();
  formExceptions.push({ year, disabled: true, start: null, end: null, note: '' });
  renderExceptionRows();
});
// 例外行里的变化用事件委托处理：停行/改期切换要重绘起止字段，其余只把值收回内存
el('zone-ex-rows').addEventListener('change', (event) => {
  const row = event.target.closest('[data-ex-row]');
  if (!row) return;
  const index = Number(row.dataset.exRow);
  if (event.target.id === `ex-kind-${index}`) {
    refreshExceptionRowFields(index);
    return;
  }
  syncExceptionRow(index);
});
el('zone-ex-rows').addEventListener('click', (event) => {
  const btn = event.target.closest('button[data-ex-remove]');
  if (!btn) return;
  formExceptions.forEach((_, index) => syncExceptionRow(index));
  formExceptions.splice(Number(btn.dataset.exRemove), 1);
  renderExceptionRows();
});
el('zone-new').addEventListener('click', () => {
  clearNotice();
  openZoneForm(null);
});
el('zone-cancel').addEventListener('click', closeZoneForm);
el('zone-filter-apply').addEventListener('click', () => {
  clearNotice();
  loadZones().catch((err) => notify(err.message, 'error'));
});
el('zone-filter-reset').addEventListener('click', () => {
  el('zone-filter-dst').value = '';
  el('zone-filter-keyword').value = '';
  loadZones().catch((err) => notify(err.message, 'error'));
});
el('zone-refresh').addEventListener('click', () => {
  clearNotice();
  loadZones().catch((err) => notify(err.message, 'error'));
});
el('zone-filter-dst').addEventListener('change', () => {
  loadZones().catch((err) => notify(err.message, 'error'));
});
el('convert-run').addEventListener('click', runConvert);
el('schedule-run').addEventListener('click', runSchedule);
el('operator').addEventListener('change', () => {
  window.localStorage.setItem(OPERATOR_KEY, currentOperator());
});

// 页面打开时先把档案拉一遍，换算台的来源时区下拉按这份清单填
fillOptions();
restoreOperator();
loadHealth();
const now = new Date();
el('convert-date').value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
el('convert-time').value = '09:30';
loadZones().catch((err) => notify(err.message, 'error'));
