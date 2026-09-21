// 页面交互：时区档案与换算台两块都从服务端拉取，任何一步失败都把说明显示在顶部并标到对应输入项上

const state = {
  zones: [],
  counts: { total: 0, dstCount: 0, noDstCount: 0 },
  editingId: '',
  lastConvert: null,
  transitionsZoneId: '',
};

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
  let target = document.querySelector(`[data-field="${field}"]`);
  if (!target && field.includes('.')) {
    // 服务端给到 dstExceptions.0.start.day 这样的细位置时，回落到最接近的外层（如 dstExceptions.0.start）
    const prefixes = [];
    const parts = field.split('.');
    for (let i = parts.length - 1; i > 0; i -= 1) {
      prefixes.push(parts.slice(0, i).join('.'));
    }
    prefixes.some((prefix) => {
      target = document.querySelector(`[data-field="${prefix}"]`);
      return !!target;
    });
  }
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

const pad2 = (num) => String(num).padStart(2, '0');

// 年度例外在档案列表里的简写法
function exceptionCellHtml(item) {
  if (!item.usesDst) return '—';
  const list = Array.isArray(item.dstExceptions) ? item.dstExceptions : [];
  if (!list.length) return '<span class="muted">无</span>';
  return list.map((ex) => {
    if (ex.disabled) {
      return `<div class="exc-line"><span class="tag exc">停做</span><span class="mono">${ex.year}</span></div>`;
    }
    const s = ex.start;
    const e = ex.end;
    const text = `${s.year}-${pad2(s.month)}-${pad2(s.day)} ${pad2(s.hour)}:${pad2(s.minute)} 起，${e.year}-${pad2(e.month)}-${pad2(e.day)} ${pad2(e.hour)}:${pad2(e.minute)} 止`;
    return `<div class="exc-line"><span class="tag exc">改期</span><span class="mono">${ex.year}</span><span class="exc-detail" title="${escapeHtml(text)}">${escapeHtml(text)}</span></div>`;
  }).join('');
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
      <td class="mono">${escapeHtml(item.yearRangeText)}</td>
      <td class="exc-cell">${exceptionCellHtml(item)}</td>
      <td class="note-cell">${escapeHtml(item.note)}</td>
      <td class="actions">
        ${item.usesDst ? `<button type="button" class="link" data-zone-transitions="${escapeHtml(item.id)}">时刻表</button>` : ''}
        <button type="button" class="link" data-zone-edit="${escapeHtml(item.id)}">编辑</button>
        <button type="button" class="link danger" data-zone-delete="${escapeHtml(item.id)}">删除</button>
      </td>
    </tr>`).join('');
  el('zone-empty').classList.toggle('hidden', state.zones.length > 0);
}

function renderConvertZoneOptions() {
  const select = el('convert-zone');
  const current = select.value;
  select.innerHTML = state.zones
    .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}　${escapeHtml(item.displayName)}</option>`)
    .join('');
  if (state.zones.some((item) => item.id === current)) select.value = current;
}

function openZoneForm(zone) {
  state.editingId = zone ? zone.id : '';
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
  renderExceptionRows(zone && Array.isArray(zone.dstExceptions) ? zone.dstExceptions : []);
  syncDstFormVisibility();
  el('zone-form').classList.remove('hidden');
  el('zone-name').focus();
}

function closeZoneForm() {
  state.editingId = '';
  el('zone-form').classList.add('hidden');
  el('exception-list').innerHTML = '';
  clearFieldMarks();
}

// 年度例外的一行草稿：年份 + 方式（改期或停做）+ 两段具体日期时刻
function exceptionRowHtml(exc, index) {
  const isDisabled = !!(exc && exc.disabled);
  const s = exc && exc.start;
  const e = exc && exc.end;
  const dateValue = (p) => (p ? `${p.year}-${pad2(p.month)}-${pad2(p.day)}` : '');
  const timeValue = (p) => (p ? `${pad2(p.hour)}:${pad2(p.minute)}` : '00:00');
  return `<div class="exc-row" data-exc-index="${index}">
    <div class="exc-row-head">
      <label data-field="dstExceptions.${index}.year">年份
        <input class="exc-year" value="${exc ? exc.year : ''}" placeholder="例如 2000" maxlength="4">
      </label>
      <label>这一年
        <select class="exc-mode">
          <option value="dates"${isDisabled ? '' : ' selected'}>改期（另定开始与结束）</option>
          <option value="disabled"${isDisabled ? ' selected' : ''}>停做夏令时</option>
        </select>
      </label>
      <button type="button" class="link danger exc-remove">删掉这条</button>
    </div>
    <div class="exc-dates"${isDisabled ? ' hidden' : ''}>
      <label data-field="dstExceptions.${index}.start">开始（日期与时刻）
        <span class="exc-datetime"><input type="date" class="exc-start-date" value="${dateValue(s)}"><input type="time" class="exc-start-time" value="${timeValue(s)}"></span>
      </label>
      <label data-field="dstExceptions.${index}.end">结束（日期与时刻，跨年可填下一年）
        <span class="exc-datetime"><input type="date" class="exc-end-date" value="${dateValue(e)}"><input type="time" class="exc-end-time" value="${timeValue(e)}"></span>
      </label>
    </div>
  </div>`;
}

function renderExceptionRows(list) {
  el('exception-list').innerHTML = list.map((exc, index) => exceptionRowHtml(exc, index)).join('');
}

function addExceptionRow() {
  const list = el('exception-list');
  list.insertAdjacentHTML('beforeend', exceptionRowHtml(null, list.children.length));
}

function splitDateTime(dateValue, timeValue, field, index, which) {
  if (!dateValue) {
    const error = new Error('要把日期填上');
    error.field = `dstExceptions.${index}.${which}`;
    throw error;
  }
  const dateParts = dateValue.split('-').map(Number);
  const timeParts = (timeValue || '00:00').split(':').map(Number);
  return { year: dateParts[0], month: dateParts[1], day: dateParts[2], hour: timeParts[0], minute: timeParts[1] };
}

// 提交时把每一行读回成 dstExceptions；前端先挡一道，服务端还会再核验
function collectExceptionPayload() {
  if (!el('zone-uses-dst').checked) return [];
  const rows = [...el('exception-list').querySelectorAll('.exc-row')];
  return rows.map((row, index) => {
    const year = row.querySelector('.exc-year').value.trim();
    if (!year) {
      const error = new Error('每条例外都要写年份');
      error.field = `dstExceptions.${index}.year`;
      throw error;
    }
    const mode = row.querySelector('.exc-mode').value;
    if (mode === 'disabled') return { year: Number(year), disabled: true, start: null, end: null };
    const start = splitDateTime(
      row.querySelector('.exc-start-date').value,
      row.querySelector('.exc-start-time').value, null, index, 'start',
    );
    const end = splitDateTime(
      row.querySelector('.exc-end-date').value,
      row.querySelector('.exc-end-time').value, null, index, 'end',
    );
    return { year: Number(year), disabled: false, start, end };
  });
}

// 不实行夏令时时，规则行与例外行一并收起来
function syncDstFormVisibility() {
  const usesDst = el('zone-uses-dst').checked;
  document.querySelectorAll('.rule-row').forEach((node) => node.classList.toggle('hidden', !usesDst));
  el('zone-dst-offset').closest('label').classList.toggle('hidden', !usesDst);
  el('exception-add').closest('.exceptions-row').classList.toggle('hidden', !usesDst);
}

async function submitZone(event) {
  event.preventDefault();
  clearNotice();
  clearFieldMarks();
  let dstExceptions;
  try {
    dstExceptions = collectExceptionPayload();
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
    return;
  }
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
    dstExceptions,
    note: el('zone-note').value,
  };
  if (!payload.usesDst) {
    payload.dstOffsetMinutes = null;
    payload.dstStart = null;
    payload.dstEnd = null;
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
  const gap = result.input.wallGap ? ` <span class="tag warn">${escapeHtml(result.input.wallGap)}</span>` : '';
  const repeat = result.input.wallRepeat ? ` <span class="tag warn">${escapeHtml(result.input.wallRepeat)}</span>` : '';
  el('convert-meta').innerHTML = `来源 ${result.input.zoneName}（${result.input.zoneDisplayName}，${result.input.offsetText}${result.input.usesDst ? `，${escapeHtml(result.input.dstStatusText)}` : ''}）的 ${result.input.date} ${result.input.time}${gap}${repeat}，换算时刻 ${formatTime(result.convertedAt)}；参与换算的档案 ${result.zonesInScope} 条，处于夏令时 ${result.dstActiveCount} 条、按年度例外走 ${result.exceptionCount} 条，与来源不同天的有 ${result.crossDayCount} 条，最大时差 ${Math.floor(result.maxDiffMinutes / 60)} 小时 ${result.maxDiffMinutes % 60} 分`;
  const body = el('convert-body');
  body.innerHTML = result.results.map((item) => `<tr class="${item.isSource ? 'source-row' : ''}">
      <td class="mono">${escapeHtml(item.name)}</td>
      <td>${escapeHtml(item.displayName)}</td>
      <td class="mono">${escapeHtml(item.localDate)}</td>
      <td class="mono">${escapeHtml(item.localTime)}</td>
      <td>${escapeHtml(item.weekday)}</td>
      <td><span class="tag ${item.dayOffset === 0 ? 'off' : 'warn'}">${escapeHtml(item.dayOffsetText)}</span></td>
      <td class="mono">${escapeHtml(item.offsetText)}${item.usesDst && item.offsetMinutes !== item.standardOffsetMinutes ? `<div class="muted small">标准 ${escapeHtml(item.standardOffsetText)}</div>` : ''}</td>
      <td>${escapeHtml(item.diffText)}</td>
      <td>${dstCellHtml(item)}</td>
    </tr>`).join('');
  el('convert-empty').classList.toggle('hidden', result.results.length > 0);
}

function dstCellHtml(item) {
  if (!item.usesDst) return '—';
  if (item.exceptionUsed) {
    return `<span class="tag exc">例外</span><div class="small">${escapeHtml(item.dstStatusText)}</div>`;
  }
  if (item.dstActive) return '<span class="tag on">夏令时</span>';
  return '<span class="tag off">标准时</span>';
}

// 切换时刻表：先看这一年有没有例外，有就按例外推算并把“例外”标出来
async function openTransitions(zoneId, year) {
  const zone = state.zones.find((item) => item.id === zoneId);
  if (!zone) return;
  state.transitionsZoneId = zoneId;
  el('transitions-title').textContent = `切换时刻表：${zone.name}`;
  el('transitions-year').value = year || String(new Date().getFullYear());
  el('transitions-panel').classList.remove('hidden');
  el('transitions-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  await runTransitions();
}

async function runTransitions() {
  const year = el('transitions-year').value.trim();
  if (!year) {
    notify('请填写要推算的年份', 'error');
    markField('transitions-year');
    return;
  }
  try {
    const result = await request(`/api/zones/${encodeURIComponent(state.transitionsZoneId)}/transitions?year=${encodeURIComponent(year)}`);
    renderTransitions(result);
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field === 'year' ? 'transitions-year' : err.field);
  }
}

function renderTransitions(result) {
  const modeText = {
    'no-dst': '这条档案不实行夏令时，没有切换可推。',
    'out-of-range': `${result.year} 年在档案生效区间之外，这一年不实行夏令时。`,
    'generic': `${result.year} 年没有年度例外，按通用规则推算。`,
    'exception-disabled': `${result.year} 年按年度例外停做夏令时，全年使用标准时间。`,
    'exception-dates': `${result.year} 年按年度例外改期，不使用通用规则的切换日期。`,
  }[result.effectiveMode] || '';
  el('transitions-meta').textContent = modeText;

  const body = el('transitions-body');
  body.innerHTML = (result.events || []).map((event) => {
    const kindText = event.kind === 'start' ? '开始夏令时' : '结束夏令时';
    const sourceTag = event.omitted
      ? '<span class="tag exc">例外</span>'
      : (event.ruleSource === 'exception'
        ? '<span class="tag exc">年度例外</span>'
        : '<span class="tag off">通用规则</span>');
    const clock = event.omitted ? '—' : `${escapeHtml(event.clockBefore)} → ${escapeHtml(event.clockAfter)}`;
    const offset = event.omitted
      ? '—'
      : `${offsetTag(event.offsetBeforeMinutes)} → ${offsetTag(event.offsetAfterMinutes)}`;
    return `<tr class="${event.ruleSource === 'exception' ? 'exception-row' : ''}">
      <td>${kindText}${event.year !== result.year ? `<div class="muted small">挂钟年份 ${event.year}</div>` : ''}</td>
      <td>${sourceTag}</td>
      <td class="mono">${clock}</td>
      <td class="mono">${event.omitted ? '—' : escapeHtml(event.utcText)}</td>
      <td class="mono">${offset}</td>
      <td>${escapeHtml(event.message)}</td>
    </tr>`;
  }).join('');
  const empty = el('transitions-empty');
  const isEmpty = !result.events || !result.events.length;
  empty.classList.toggle('hidden', !isEmpty);
  empty.textContent = isEmpty ? (result.usesDst ? '这一年没有切换记录' : '这条档案不实行夏令时') : '';
}

function offsetTag(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `UTC${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

// 列表上的操作用事件委托统一处理，列表重绘之后不需要重新绑定
document.addEventListener('click', async (event) => {
  const node = event.target.closest('button');
  if (node) {
    if (node.id === 'exception-add') {
      addExceptionRow();
      return;
    }
    if (node.classList.contains('exc-remove')) {
      const row = node.closest('.exc-row');
      const list = el('exception-list');
      if (row) row.remove();
      [...list.children].forEach((child, index) => { child.dataset.excIndex = String(index); });
      return;
    }
    if (node.id === 'transitions-run') {
      await runTransitions();
      return;
    }
    if (node.id === 'transitions-close') {
      el('transitions-panel').classList.add('hidden');
      state.transitionsZoneId = '';
      return;
    }
  }

  if (!node) return;

  if (node.dataset.zoneTransitions) {
    clearNotice();
    await openTransitions(node.dataset.zoneTransitions);
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
    const found = state.zones.find((item) => item.id === node.dataset.zoneDelete);
    if (!window.confirm(`确定删除 ${found ? found.name : ''} 这条档案吗？`)) return;
    try {
      await request(`/api/zones/${encodeURIComponent(node.dataset.zoneDelete)}`, { method: 'DELETE' });
      if (state.editingId === node.dataset.zoneDelete) closeZoneForm();
      if (state.transitionsZoneId === node.dataset.zoneDelete) {
        el('transitions-panel').classList.add('hidden');
        state.transitionsZoneId = '';
      }
      notify('时区档案已删除', 'ok');
      await loadZones();
    } catch (err) {
      notify(err.message, 'error');
    }
  }
});

// 例外行里切换“改期 / 停做”，只显示用得上的日期时刻
document.addEventListener('change', (event) => {
  if (event.target.classList && event.target.classList.contains('exc-mode')) {
    const dates = event.target.closest('.exc-row').querySelector('.exc-dates');
    if (dates) dates.classList.toggle('hidden', event.target.value === 'disabled');
  }
});

el('zone-form').addEventListener('submit', submitZone);
el('zone-uses-dst').addEventListener('change', syncDstFormVisibility);
el('transitions-year').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    runTransitions();
  }
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
