const crypto = require('crypto');
const { load, save, MIN_OFFSET, MAX_OFFSET, MIN_YEAR, MAX_YEAR, MAX_NAME_LENGTH, MAX_DISPLAY_NAME_LENGTH, MAX_NOTE_LENGTH } = require('./store');
const { ApiError, pickText } = require('./errors');
const dst = require('./dst');

// 时区名固定成地区加城市的写法，UTC 单独允许
const NAME_PATTERN = /^([A-Za-z_]+(\/[A-Za-z_]+)+|UTC)$/;
const WEEK_TOKENS = ['1', '2', '3', '4', 'last'];

function validateName(value, data, selfId) {
  const name = pickText(value);
  if (!name) throw new ApiError(400, 'NAME_REQUIRED', '请填写时区名称', 'name');
  if (name.length > MAX_NAME_LENGTH) {
    throw new ApiError(400, 'NAME_TOO_LONG', `时区名称不能超过 ${MAX_NAME_LENGTH} 个字符`, 'name');
  }
  if (!NAME_PATTERN.test(name)) {
    throw new ApiError(400, 'NAME_INVALID', '时区名称要写成地区加城市，例如 Asia/Shanghai，基准时可以写 UTC', 'name');
  }
  const hit = data.zones.find((item) => item.id !== selfId && item.name.toLowerCase() === name.toLowerCase());
  if (hit) throw new ApiError(409, 'NAME_DUPLICATED', `${hit.name} 已经登记过了`, 'name');
  return name;
}

function validateDisplayName(value) {
  const displayName = pickText(value);
  if (!displayName) throw new ApiError(400, 'DISPLAY_NAME_REQUIRED', '请填写显示名称', 'displayName');
  if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new ApiError(400, 'DISPLAY_NAME_TOO_LONG', `显示名称不能超过 ${MAX_DISPLAY_NAME_LENGTH} 个字符`, 'displayName');
  }
  return displayName;
}

// 偏移一律按分钟存，允许半小时与三刻这样的写法
function validateOffset(value, field) {
  const raw = typeof value === 'number' ? value : Number(pickText(String(value === undefined || value === null ? '' : value)));
  if (!Number.isInteger(raw)) {
    throw new ApiError(400, 'OFFSET_INVALID', '偏移要写成整数分钟，例如东八区写 480', field);
  }
  if (raw < MIN_OFFSET || raw > MAX_OFFSET) {
    throw new ApiError(400, 'OFFSET_OUT_OF_RANGE', `偏移要在 ${MIN_OFFSET} 到 ${MAX_OFFSET} 分钟之间`, field);
  }
  return raw;
}

// 夏令时规则里的一段：第几个星期几的几点几分
function validateRulePart(value, field) {
  const source = value && typeof value === 'object' ? value : {};
  const month = Number(source.month);
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new ApiError(400, 'DST_MONTH_INVALID', '切换月份要填一到十二', field);
  }
  const week = String(source.week);
  if (!WEEK_TOKENS.includes(week)) {
    throw new ApiError(400, 'DST_WEEK_INVALID', '第几个星期只能填一到四，或者填最后一个', field);
  }
  const weekday = Number(source.weekday);
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    throw new ApiError(400, 'DST_WEEKDAY_INVALID', '星期要填零到六，零表示周日', field);
  }
  const hour = Number(source.hour);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new ApiError(400, 'DST_HOUR_INVALID', '切换时刻的小时要填零到二十三', field);
  }
  const minute = Number(source.minute);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new ApiError(400, 'DST_MINUTE_INVALID', '切换时刻的分钟要填零到五十九', field);
  }
  return { month, week, weekday, hour, minute };
}

function sameRulePart(a, b) {
  if (!a || !b) return false;
  return a.month === b.month && a.week === b.week && a.weekday === b.weekday
    && a.hour === b.hour && a.minute === b.minute;
}

function validateYear(value, field, label) {
  if (value === undefined || value === null || value === '') return null;
  const year = Number(value);
  if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) {
    throw new ApiError(400, 'YEAR_INVALID', `${label}要填 ${MIN_YEAR} 到 ${MAX_YEAR} 之间的整数`, field);
  }
  return year;
}

function validateNote(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new ApiError(400, 'NOTE_INVALID', '备注需要是文本', 'note');
  if (value.length > MAX_NOTE_LENGTH) {
    throw new ApiError(400, 'NOTE_TOO_LONG', `备注不能超过 ${MAX_NOTE_LENGTH} 个字符`, 'note');
  }
  return value.trim();
}

// 年度例外里的一段具体日期时刻，用它自己的年份核验日期是否存在，例如 2021-02-29 不成立
function validateExceptionPart(value, index, which, allowedYears, allowedLabel) {
  const field = `dstExceptions.${index}.${which}`;
  const source = value && typeof value === 'object' ? value : null;
  if (!source) throw new ApiError(400, 'EXCEPTION_DATE_REQUIRED', `要把${which === 'start' ? '开始' : '结束'}日期与时刻填上`, field);

  const year = Number(source.year);
  if (!Number.isInteger(year)) {
    throw new ApiError(400, 'EXCEPTION_YEAR_INVALID', '例外日期的年份要写成整数', `${field}.year`);
  }
  const month = Number(source.month);
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new ApiError(400, 'EXCEPTION_MONTH_INVALID', '月份要填一到十二', `${field}.month`);
  }
  const day = Number(source.day);
  if (!Number.isInteger(day) || day < 1 || day > 31) {
    throw new ApiError(400, 'EXCEPTION_DAY_INVALID', '日期要填一到三十一', `${field}.day`);
  }
  const hour = Number(source.hour);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new ApiError(400, 'EXCEPTION_HOUR_INVALID', '小时要填零到二十三', `${field}.hour`);
  }
  const minute = Number(source.minute);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new ApiError(400, 'EXCEPTION_MINUTE_INVALID', '分钟要填零到五十九', `${field}.minute`);
  }
  if (!allowedYears.includes(year)) {
    throw new ApiError(400, 'EXCEPTION_DATE_YEAR_MISMATCH',
      `${which === 'start' ? '开始' : '结束'}日期的年份${allowedLabel}`, `${field}.year`);
  }
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new ApiError(400, 'EXCEPTION_DATE_NOT_EXIST', `${year} 年 ${month} 月没有 ${day} 号这一天`, `${field}.day`);
  }
  return { year, month, day, hour, minute };
}

function partToMs(part) {
  return Date.UTC(part.year, part.month - 1, part.day, part.hour, part.minute);
}

// 年度例外列表：年份要在生效区间内、不能重复、日期要真存在、开始要早于结束
function validateExceptions(value, ctx) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ApiError(400, 'EXCEPTION_LIST_INVALID', '年度例外要写成列表', 'dstExceptions');
  }
  if (!ctx.usesDst && value.length > 0) {
    throw new ApiError(400, 'EXCEPTION_WITHOUT_DST', '不实行夏令时的档案不能写年度例外', 'dstExceptions');
  }

  const upper = ctx.toYear === null ? MAX_YEAR : ctx.toYear;
  const seen = new Set();
  const result = [];

  value.forEach((raw, index) => {
    const fieldYear = `dstExceptions.${index}.year`;
    const source = raw && typeof raw === 'object' ? raw : null;
    if (!source) {
      throw new ApiError(400, 'EXCEPTION_SHAPE_INVALID', `第 ${index + 1} 条例外没写完整`, `dstExceptions.${index}`);
    }
    const year = Number(source.year);
    if (!Number.isInteger(year)) {
      throw new ApiError(400, 'EXCEPTION_YEAR_REQUIRED', '每条例外都要写年份', fieldYear);
    }
    if (year < MIN_YEAR || year > MAX_YEAR) {
      throw new ApiError(400, 'EXCEPTION_YEAR_INVALID', `例外年份要在 ${MIN_YEAR} 到 ${MAX_YEAR} 之间`, fieldYear);
    }
    if (year < ctx.fromYear || year > upper) {
      const range = ctx.toYear === null
        ? `${ctx.fromYear} 年以后`
        : `${ctx.fromYear} 到 ${ctx.toYear} 年之间`;
      throw new ApiError(400, 'EXCEPTION_YEAR_OUT_OF_RANGE', `例外年份要落在档案生效区间内（${range}）`, fieldYear);
    }
    if (seen.has(year)) {
      throw new ApiError(400, 'EXCEPTION_YEAR_DUPLICATED', `${year} 年的例外写了两次，同一年只能写一条`, fieldYear);
    }
    seen.add(year);

    const disabled = source.disabled === true || source.disabled === 'true';
    const hasStart = source.start !== undefined && source.start !== null;
    const hasEnd = source.end !== undefined && source.end !== null;

    if (disabled) {
      if (hasStart || hasEnd) {
        throw new ApiError(400, 'EXCEPTION_DISABLED_WITH_DATES',
          `${year} 年既写了停做夏令时，就不要再写开始与结束日期`, `dstExceptions.${index}`);
      }
      result.push({ year, disabled: true, start: null, end: null });
      return;
    }
    if (!hasStart || !hasEnd) {
      throw new ApiError(400, 'EXCEPTION_MODE_INVALID',
        `${year} 年的例外要写明是停做夏令时，还是把开始与结束日期都改掉`, `dstExceptions.${index}`);
    }

    // 北半球开始与结束同在这一年；南半球按通用规则跨年时，结束允许写到下一年
    const endAllowed = ctx.crossYear ? [year, year + 1] : [year];
    const endLabel = ctx.crossYear ? `要写在 ${year} 年（跨年规则可写到 ${year + 1} 年）` : `要写在 ${year} 年`;
    const start = validateExceptionPart(source.start, index, 'start', [year], `要写在 ${year} 年`);
    const end = validateExceptionPart(source.end, index, 'end', endAllowed, endLabel);
    if (partToMs(start) >= partToMs(end)) {
      throw new ApiError(400, 'EXCEPTION_ORDER_INVALID',
        `${year} 年的例外把开始挪到了结束之后（含时刻），推算不出夏令时区间`, `dstExceptions.${index}.end`);
    }
    result.push({ year, disabled: false, start, end });
  });

  result.sort((a, b) => a.year - b.year);
  return result;
}

// 一整条档案的校验：偏移、夏令时三段与生效年份要能对得上
function validatePayload(input, data, selfId) {
  const name = validateName(input.name, data, selfId);
  const displayName = validateDisplayName(input.displayName);
  const offsetMinutes = validateOffset(input.offsetMinutes, 'offsetMinutes');
  const usesDst = input.usesDst === true || input.usesDst === 'true';
  const fromYear = validateYear(input.fromYear, 'fromYear', '开始年份');
  const toYear = validateYear(input.toYear, 'toYear', '结束年份');

  if (fromYear !== null && toYear !== null && toYear < fromYear) {
    throw new ApiError(400, 'YEAR_RANGE_INVALID', '结束年份不能早于开始年份', 'toYear');
  }

  let dstOffsetMinutes = null;
  let dstStart = null;
  let dstEnd = null;
  let crossYear = false;

  if (usesDst) {
    dstOffsetMinutes = validateOffset(input.dstOffsetMinutes, 'dstOffsetMinutes');
    if (dstOffsetMinutes <= offsetMinutes) {
      throw new ApiError(400, 'DST_OFFSET_INVALID', '夏令时偏移要比标准偏移更靠前，也就是数值更大', 'dstOffsetMinutes');
    }
    if (!input.dstStart || !input.dstEnd) {
      throw new ApiError(400, 'DST_RULE_REQUIRED', '实行夏令时的时区要把开始与结束两段规则都填上', 'dstStart');
    }
    dstStart = validateRulePart(input.dstStart, 'dstStart');
    dstEnd = validateRulePart(input.dstEnd, 'dstEnd');
    if (sameRulePart(dstStart, dstEnd)) {
      throw new ApiError(400, 'DST_RULE_SAME', '开始与结束两段规则不能完全相同，否则推算不出切换区间', 'dstEnd');
    }
    // 开始月份晚于结束月份表示南半球跨年实行夏令时，年度例外的结束日期因此允许写到下一年
    crossYear = dstStart.month > dstEnd.month;
  }

  const resolvedFromYear = fromYear === null ? MIN_YEAR : fromYear;
  const dstExceptions = validateExceptions(input.dstExceptions, {
    usesDst,
    fromYear: resolvedFromYear,
    toYear,
    crossYear,
  });

  return {
    name,
    displayName,
    offsetMinutes,
    usesDst,
    dstOffsetMinutes,
    dstStart,
    dstEnd,
    dstExceptions,
    fromYear: resolvedFromYear,
    toYear,
    note: validateNote(input.note),
  };
}

// 偏移的展示写法，半小时与三刻都要看得清
function offsetText(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const hour = String(Math.floor(abs / 60)).padStart(2, '0');
  const minute = String(abs % 60).padStart(2, '0');
  return `UTC${sign}${hour}:${minute}`;
}

function withOffsetText(zone) {
  const exceptions = Array.isArray(zone.dstExceptions) ? zone.dstExceptions : [];
  return {
    ...zone,
    dstExceptions: exceptions,
    offsetText: offsetText(zone.offsetMinutes),
    dstOffsetText: zone.usesDst && zone.dstOffsetMinutes !== null ? offsetText(zone.dstOffsetMinutes) : '',
    yearRangeText: zone.toYear === null ? `${zone.fromYear} 年起` : `${zone.fromYear} 至 ${zone.toYear}`,
    exceptionCount: exceptions.length,
    exceptionYearsText: exceptions.map((item) => String(item.year)).join('、'),
  };
}

function sortZones(list) {
  return list.slice().sort((a, b) => {
    if (a.offsetMinutes !== b.offsetMinutes) return a.offsetMinutes - b.offsetMinutes;
    return a.name < b.name ? -1 : 1;
  });
}

// 档案清单：按是否实行夏令时筛选，再按名称、显示名或备注搜索
function listZones(options) {
  const input = options && typeof options === 'object' ? options : {};
  const dst = pickText(input.dst);
  const keyword = pickText(input.keyword).toLowerCase();
  const data = load();

  let list = data.zones;
  if (dst === 'yes') list = list.filter((item) => item.usesDst);
  if (dst === 'no') list = list.filter((item) => !item.usesDst);
  if (keyword) {
    list = list.filter((item) => item.name.toLowerCase().includes(keyword)
      || item.displayName.toLowerCase().includes(keyword)
      || item.note.toLowerCase().includes(keyword));
  }

  return {
    zones: sortZones(list).map(withOffsetText),
    total: data.zones.length,
    dstCount: data.zones.filter((item) => item.usesDst).length,
    noDstCount: data.zones.filter((item) => !item.usesDst).length,
  };
}

function getZone(id) {
  const data = load();
  const found = data.zones.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'ZONE_NOT_FOUND', '这条时区档案不存在或已被删除', '');
  return withOffsetText(found);
}

function createZone(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const checked = validatePayload(input, data, '');
  const now = new Date().toISOString();
  const created = { id: crypto.randomUUID(), ...checked, createdAt: now, updatedAt: now };
  data.zones.push(created);
  save(data);
  return withOffsetText(created);
}

function updateZone(id, payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const found = data.zones.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'ZONE_NOT_FOUND', '这条时区档案不存在或已被删除', '');

  const merged = {
    name: input.name === undefined ? found.name : input.name,
    displayName: input.displayName === undefined ? found.displayName : input.displayName,
    offsetMinutes: input.offsetMinutes === undefined ? found.offsetMinutes : input.offsetMinutes,
    usesDst: input.usesDst === undefined ? found.usesDst : (input.usesDst === true || input.usesDst === 'true'),
    dstOffsetMinutes: input.dstOffsetMinutes === undefined ? found.dstOffsetMinutes : input.dstOffsetMinutes,
    dstStart: input.dstStart === undefined ? found.dstStart : input.dstStart,
    dstEnd: input.dstEnd === undefined ? found.dstEnd : input.dstEnd,
    fromYear: input.fromYear === undefined ? found.fromYear : input.fromYear,
    toYear: input.toYear === undefined ? found.toYear : input.toYear,
    dstExceptions: input.dstExceptions === undefined ? found.dstExceptions : input.dstExceptions,
    note: input.note === undefined ? found.note : input.note,
  };

  const checked = validatePayload(merged, data, found.id);
  Object.assign(found, checked);
  found.updatedAt = new Date().toISOString();
  save(data);
  return withOffsetText(found);
}

function deleteZone(id) {
  const data = load();
  const index = data.zones.findIndex((item) => item.id === id);
  if (index === -1) throw new ApiError(404, 'ZONE_NOT_FOUND', '这条时区档案不存在或已被删除', '');
  const [removed] = data.zones.splice(index, 1);
  save(data);
  return { id: removed.id, name: removed.name, displayName: removed.displayName };
}

// 单条档案某一年的切换时刻表，通用规则与年度例外各按各的来，并标明走的是哪一个
function getZoneTransitions(id, yearValue) {
  const data = load();
  const zone = data.zones.find((item) => item.id === id);
  if (!zone) throw new ApiError(404, 'ZONE_NOT_FOUND', '这条时区档案不存在或已被删除', '');

  const raw = yearValue === undefined || yearValue === null || yearValue === '' ? null : Number(yearValue);
  if (raw === null) {
    throw new ApiError(400, 'YEAR_REQUIRED', '请填写要推算的年份', 'year');
  }
  if (!dst.isValidYear(raw)) {
    throw new ApiError(400, 'YEAR_INVALID', `年份要填 ${MIN_YEAR} 到 ${MAX_YEAR} 之间的整数`, 'year');
  }

  const detail = dst.transitionsForYear(zone, raw);
  const exceptions = Array.isArray(zone.dstExceptions) ? zone.dstExceptions : [];
  const exception = exceptions.find((item) => item.year === raw) || null;
  return {
    zone: withOffsetText(zone),
    year: raw,
    usesDst: zone.usesDst,
    inRange: detail.inRange,
    crossYear: dst.crossYearRule(zone),
    exception,
    exceptionText: exception ? dst.exceptionText(exception) : '',
    effectiveMode: !zone.usesDst
      ? 'no-dst'
      : (!detail.inRange ? 'out-of-range' : (exception ? (exception.disabled ? 'exception-disabled' : 'exception-dates') : 'generic')),
    events: detail.events,
  };
}

module.exports = {
  listZones,
  getZone,
  createZone,
  updateZone,
  deleteZone,
  getZoneTransitions,
  offsetText,
  withOffsetText,
};
