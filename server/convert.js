const { load, WEEKDAY_NAMES } = require('./store');
const { ApiError, pickText } = require('./errors');
const { offsetText } = require('./zones');
const dst = require('./dst');

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

// 夏令时状态的文字与标记；走年度例外的年份要把“例外”两个字写明
function dstStatus(zone, info) {
  if (!zone.usesDst) {
    return { status: 'none', dstActive: false, exceptionUsed: false, exceptionYear: null, text: '不实行', tag: '' };
  }
  if (info.dstActive) {
    return info.exceptionYear !== null
      ? { status: 'dst-exception', dstActive: true, exceptionUsed: true, exceptionYear: info.exceptionYear, text: `夏令时（${info.exceptionYear} 年例外）`, tag: '例外' }
      : { status: 'dst', dstActive: true, exceptionUsed: false, exceptionYear: null, text: '夏令时', tag: '' };
  }
  if (info.exceptionYear !== null) {
    const exception = (zone.dstExceptions || []).find((item) => item.year === info.exceptionYear);
    const reason = exception && !exception.disabled ? '改期后此刻仍在标准时' : '例外停做';
    return { status: 'standard-exception', dstActive: false, exceptionUsed: true, exceptionYear: info.exceptionYear, text: `标准时（${info.exceptionYear} 年${reason}）`, tag: '例外' };
  }
  return { status: 'standard', dstActive: false, exceptionUsed: false, exceptionYear: null, text: '标准时', tag: '' };
}

// 换算：先把来源时区填的当地时刻折成基准（UTC），再逐个时区按这一刻实际生效的偏移加上去
function convert(options) {
  const input = options && typeof options === 'object' ? options : {};
  const date = validateDate(input.date);
  const time = validateTime(input.time);
  const zoneId = pickText(input.zoneId);
  if (!zoneId) throw new ApiError(400, 'ZONE_REQUIRED', '请选择来源时区', 'zoneId');

  const data = load();
  const source = data.zones.find((item) => item.id === zoneId);
  if (!source) throw new ApiError(404, 'ZONE_NOT_FOUND', '选中的时区没有登记过', 'zoneId');

  const sourceWallMs = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute);
  const resolved = dst.resolveWallInput(source, sourceWallMs);
  const utcMs = resolved.utcMs;
  const baseDay = Math.floor(sourceWallMs / DAY_MS);
  const utcDate = new Date(utcMs);

  const results = data.zones.map((zone) => {
    const info = dst.effectiveOffsetAtUtc(zone, utcMs);
    const status = dstStatus(zone, info);
    const localMs = utcMs + info.offsetMinutes * 60000;
    const local = new Date(localMs);
    const dayOffset = Math.floor(localMs / DAY_MS) - baseDay;
    const diffMinutes = info.offsetMinutes - resolved.appliedOffsetMinutes;
    return {
      zoneId: zone.id,
      name: zone.name,
      displayName: zone.displayName,
      offsetMinutes: info.offsetMinutes,
      standardOffsetMinutes: zone.offsetMinutes,
      offsetText: offsetText(info.offsetMinutes),
      standardOffsetText: offsetText(zone.offsetMinutes),
      localDate: `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`,
      localTime: `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`,
      weekday: WEEKDAY_NAMES[local.getUTCDay()],
      dayOffset,
      dayOffsetText: dayOffsetText(dayOffset),
      diffMinutes,
      diffText: diffText(diffMinutes),
      usesDst: zone.usesDst,
      dstActive: status.dstActive,
      dstStatus: status.status,
      dstStatusText: status.text,
      exceptionUsed: status.exceptionUsed,
      exceptionYear: status.exceptionYear,
      isSource: zone.id === source.id,
    };
  });

  results.sort((a, b) => {
    if (a.offsetMinutes !== b.offsetMinutes) return a.offsetMinutes - b.offsetMinutes;
    return a.name < b.name ? -1 : 1;
  });

  const sourceStatus = dstStatus(source, dst.effectiveOffsetAtUtc(source, utcMs));

  return {
    input: {
      date: date.text,
      time: time.text,
      zoneId: source.id,
      zoneName: source.name,
      zoneDisplayName: source.displayName,
      offsetText: offsetText(resolved.appliedOffsetMinutes),
      standardOffsetText: offsetText(source.offsetMinutes),
      usesDst: source.usesDst,
      dstActive: sourceStatus.dstActive,
      dstStatusText: sourceStatus.text,
      wallGap: resolved.kind === 'skipped' ? resolved.message : '',
      wallRepeat: resolved.kind === 'repeated' ? resolved.message : '',
    },
    standard: {
      date: `${utcDate.getUTCFullYear()}-${pad(utcDate.getUTCMonth() + 1)}-${pad(utcDate.getUTCDate())}`,
      time: `${pad(utcDate.getUTCHours())}:${pad(utcDate.getUTCMinutes())}`,
    },
    zonesInScope: data.zones.length,
    crossDayCount: results.filter((item) => item.dayOffset !== 0).length,
    exceptionCount: results.filter((item) => item.exceptionUsed).length,
    dstActiveCount: results.filter((item) => item.dstActive).length,
    maxDiffMinutes: results.reduce((acc, item) => Math.max(acc, Math.abs(item.diffMinutes)), 0),
    results,
    convertedAt: new Date().toISOString(),
  };
}

module.exports = { convert, validateDate, validateTime, diffText, dayOffsetText };
