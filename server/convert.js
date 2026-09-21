const { load, WEEKDAY_NAMES } = require('./store');
const { ApiError, pickText } = require('./errors');
const { offsetText } = require('./zones');
const { isDstAt, dstStateAtUtc } = require('./dst');

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_MS = 86400000;

const pad = (num) => String(num).padStart(2, '0');

// 日期要真存在，例如 2026-02-30 这种不能算数
function validateDate(value) {
  const date = pickText(value);
  if (!date) throw new ApiError(400, 'DATE_REQUIRED', '请填写日期', 'date');
  if (!DATE_PATTERN.test(date)) {
    throw new ApiError(400, 'DATE_INVALID', '日期要写成四位年加短横线加两位月日，例如 2026-09-20', 'date');
  }
  const [year, month, day] = date.split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new ApiError(400, 'DATE_INVALID', '这个日期不存在，请检查月份与日', 'date');
  }
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new ApiError(400, 'DATE_INVALID', '这个日期不存在，例如二月没有三十号', 'date');
  }
  return { text: date, year, month, day };
}

function validateTime(value) {
  const time = pickText(value);
  if (!time) throw new ApiError(400, 'TIME_REQUIRED', '请填写时刻', 'time');
  if (!TIME_PATTERN.test(time)) {
    throw new ApiError(400, 'TIME_INVALID', '时刻要写成两位小时加冒号加两位分钟，例如 09:30', 'time');
  }
  const [hour, minute] = time.split(':').map(Number);
  return { text: time, hour, minute };
}

// 时差写法：整小时只写小时，带分钟的把分钟也写出来
function diffText(minutes) {
  if (minutes === 0) return '与源时区相同';
  const sign = minutes > 0 ? '早' : '晚';
  const abs = Math.abs(minutes);
  const hour = Math.floor(abs / 60);
  const minute = abs % 60;
  const parts = [];
  if (hour) parts.push(`${hour} 小时`);
  if (minute) parts.push(`${minute} 分`);
  return `比源时区${sign} ${parts.join(' ')}`;
}

function dayOffsetText(dayOffset) {
  if (dayOffset === 0) return '同日';
  if (dayOffset > 0) return `后 ${dayOffset} 天`;
  return `前 ${Math.abs(dayOffset)} 天`;
}

// 把夏令时判定结果折算成有效偏移；rule 表示走通用规则，moved/skipped 表示走年度例外
function stateFromStatus(zone, status) {
  if (!zone.usesDst || status.kind === 'none') {
    return { offsetMinutes: zone.offsetMinutes, dstActive: false, dstKind: 'none', exceptionYear: null };
  }
  if (status.dst) {
    return {
      offsetMinutes: zone.dstOffsetMinutes,
      dstActive: true,
      dstKind: status.kind,
      exceptionYear: status.kind === 'moved' && status.exception ? status.exception.year : null,
    };
  }
  return {
    offsetMinutes: zone.offsetMinutes,
    dstActive: false,
    dstKind: status.kind, // standard：通用规则下的标准时间；skipped：该年例外停行
    exceptionYear: status.kind === 'skipped' && status.exception ? status.exception.year : null,
  };
}

// 来源时区：用户输入的是当地挂钟时刻，按挂钟规则判定
function sourceClockState(zone, year, month, day, hour, minute) {
  return stateFromStatus(zone, isDstAt(zone, year, month, day, hour, minute));
}

// 目标时区：拿到的是基准（UTC）绝对时刻，按绝对时刻精确判定，避开回退日的重复小时
function targetClockState(zone, utcMs) {
  return stateFromStatus(zone, dstStateAtUtc(zone, utcMs));
}

// 页面上夏令时那一列要给的说法
function dstBasisText(state) {
  switch (state.dstKind) {
    case 'none':
      return '不实行夏令时';
    case 'rule':
      return '夏令时 · 通用规则';
    case 'moved':
      return `夏令时 · ${state.exceptionYear} 年例外改期`;
    case 'skipped':
      return `标准时间 · ${state.exceptionYear} 年例外停行`;
    default:
      return '标准时间';
  }
}

// 换算：先把输入时刻按来源时区当时的有效偏移（含夏令时与年度例外）折算成基准时刻，
// 再逐个时区按各自当时的有效偏移加上去
function convert(options) {
  const input = options && typeof options === 'object' ? options : {};
  const date = validateDate(input.date);
  const time = validateTime(input.time);
  const zoneId = pickText(input.zoneId);
  if (!zoneId) throw new ApiError(400, 'ZONE_REQUIRED', '请选择来源时区', 'zoneId');

  const data = load();
  const source = data.zones.find((item) => item.id === zoneId);
  if (!source) throw new ApiError(404, 'ZONE_NOT_FOUND', '选中的时区没有登记过', 'zoneId');

  const sourceState = sourceClockState(source, date.year, date.month, date.day, time.hour, time.minute);

  const baseMs = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute);
  const utcMs = baseMs - sourceState.offsetMinutes * 60000;
  const baseDay = Math.floor(baseMs / DAY_MS);
  const utcDate = new Date(utcMs);

  const results = data.zones.map((zone) => {
    // 来源那一行直接回显对输入时刻的解释（重复小时等歧义按挂钟区间取定），
    // 避免它再按绝对时刻重算后与用户输入的当地时刻对不上；其余时区按绝对时刻精确判定
    const state = zone.id === source.id
      ? sourceState
      : targetClockState(zone, utcMs);
    const localMs = utcMs + state.offsetMinutes * 60000;
    const local = new Date(localMs);
    const dayOffset = Math.floor(localMs / DAY_MS) - baseDay;
    const diffMinutes = state.offsetMinutes - sourceState.offsetMinutes;
    return {
      zoneId: zone.id,
      name: zone.name,
      displayName: zone.displayName,
      offsetMinutes: state.offsetMinutes,
      offsetText: offsetText(state.offsetMinutes),
      standardOffsetText: offsetText(zone.offsetMinutes),
      localDate: `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`,
      localTime: `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`,
      weekday: WEEKDAY_NAMES[local.getUTCDay()],
      dayOffset,
      dayOffsetText: dayOffsetText(dayOffset),
      diffMinutes,
      diffText: diffText(diffMinutes),
      usesDst: zone.usesDst,
      dstActive: state.dstActive,
      dstKind: state.dstKind,
      dstBasisText: dstBasisText(state),
      exceptionYear: state.exceptionYear,
      isSource: zone.id === source.id,
    };
  });

  results.sort((a, b) => {
    if (a.offsetMinutes !== b.offsetMinutes) return a.offsetMinutes - b.offsetMinutes;
    return a.name < b.name ? -1 : 1;
  });

  return {
    input: {
      date: date.text,
      time: time.text,
      zoneId: source.id,
      zoneName: source.name,
      zoneDisplayName: source.displayName,
      offsetText: offsetText(sourceState.offsetMinutes),
      usesDst: source.usesDst,
      dstActive: sourceState.dstActive,
      dstBasisText: dstBasisText(sourceState),
    },
    standard: {
      date: `${utcDate.getUTCFullYear()}-${pad(utcDate.getUTCMonth() + 1)}-${pad(utcDate.getUTCDate())}`,
      time: `${pad(utcDate.getUTCHours())}:${pad(utcDate.getUTCMinutes())}`,
    },
    zonesInScope: data.zones.length,
    crossDayCount: results.filter((item) => item.dayOffset !== 0).length,
    dstActiveCount: results.filter((item) => item.dstActive).length,
    exceptionCount: results.filter((item) => item.exceptionYear !== null).length,
    maxDiffMinutes: results.reduce((acc, item) => Math.max(acc, Math.abs(item.diffMinutes)), 0),
    results,
    convertedAt: new Date().toISOString(),
  };
}

module.exports = { convert, validateDate, validateTime, diffText, dayOffsetText, dstBasisText };
