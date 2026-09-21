// 夏令时推算：把"第几个星期几的几点几分"的通用规则落到某一年的具体日期时刻，
// 再让该年的年度例外覆盖通用规则。换算与切换时刻表都只认这里给出的结论。
const { ApiError } = require('./errors');
const { WEEKDAY_NAMES, MONTH_NAMES, MIN_YEAR, MAX_YEAR } = require('./store');

const pad = (num) => String(num).padStart(2, '0');
const WEEK_LABEL = Object.fromEntries(WEEKDAY_NAMES.map((name, index) => [index, name]));
const MONTH_LABEL = Object.fromEntries(MONTH_NAMES.map((name, index) => [index + 1, name]));

// 通用规则的一段在某一年的具体日期：第几个星期几。week 为 'last' 时取该月最后一个
function resolveRuleDate(part, year) {
  const firstWeekday = new Date(Date.UTC(year, part.month - 1, 1)).getUTCDay();
  let day = 1 + ((part.weekday - firstWeekday + 7) % 7);
  if (part.week === 'last') {
    const daysInMonth = new Date(Date.UTC(year, part.month, 0)).getUTCDate();
    while (day + 7 <= daysInMonth) day += 7;
  } else {
    day += (Number(part.week) - 1) * 7;
  }
  return Date.UTC(year, part.month - 1, day, part.hour, part.minute);
}

// 某一年是否落在档案的生效年份区间内
function yearInEffect(zone, year) {
  if (year < zone.fromYear) return false;
  if (zone.toYear !== null && year > zone.toYear) return false;
  return true;
}

// 取该年的年度例外（同一年至多一条，写入时已保证）
function exceptionForYear(zone, year) {
  const list = Array.isArray(zone.dstExceptions) ? zone.dstExceptions : [];
  return list.find((item) => item.year === year) || null;
}

// 该年夏令时安排。返回的来源标记：
//   rule    —— 按通用规则
//   skipped —— 该年例外停行
//   moved   —— 该年例外改期
//   none    —— 档案本就不实行夏令时
//   out     —— 年份在生效区间之外
function yearPlan(zone, year) {
  if (!zone.usesDst) return { year, kind: 'none' };
  if (!yearInEffect(zone, year)) return { year, kind: 'out' };

  const exc = exceptionForYear(zone, year);
  if (!exc) {
    return {
      year,
      kind: 'rule',
      startMs: resolveRuleDate(zone.dstStart, year),
      endMs: resolveRuleDate(zone.dstEnd, year),
      startPart: zone.dstStart,
      endPart: zone.dstEnd,
    };
  }
  if (exc.disabled) {
    return { year, kind: 'skipped', exception: exc };
  }
  return {
    year,
    kind: 'moved',
    startMs: Date.UTC(year, exc.start.month - 1, exc.start.day, exc.start.hour, exc.start.minute),
    endMs: Date.UTC(year, exc.end.month - 1, exc.end.day, exc.end.hour, exc.end.minute),
    exception: exc,
  };
}

// 跨年区间时，结束这一段实际发生在开始的下一年，把它的月日时刻整体推到次年
function addCalendarYear(ms) {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear() + 1, date.getUTCMonth(), date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes());
}

// 取一个年安排的实际夏令时区间（两端均为绝对时刻，左闭右开）。
// 南半球开始月份晚于结束月份时，结束发生在次年：
//   通用规则要在次年按"第几个星期几"重新落日期，直接加一年会把星期几弄错；
//   改期例外给的是写死的日期，加一年保留月日即可
function planInterval(plan) {
  if (plan.kind !== 'rule' && plan.kind !== 'moved') return null;
  if (plan.startMs <= plan.endMs) return { startMs: plan.startMs, endMs: plan.endMs, crossYear: false };
  const endMs = plan.kind === 'rule'
    ? resolveRuleDate(plan.endPart, plan.year + 1)
    : addCalendarYear(plan.endMs);
  return { startMs: plan.startMs, endMs, crossYear: true };
}

// 判断一个挂钟日期时刻是否落在夏令时区间内，兼容南半球跨年区间。
// 用所属公历年取该年区间，年初那几天还要用前一年跨过来的区间兜底
function isDstAt(zone, year, month, day, hour, minute) {
  if (!zone.usesDst) return { dst: false, kind: 'none' };

  // 这一年例外停行：全年都用标准时间，前一年跨到这一年年初的那段也不再生效
  const current = yearPlan(zone, year);
  if (current.kind === 'skipped') {
    return { dst: false, kind: 'skipped', exception: current.exception };
  }

  const when = Date.UTC(year, month - 1, day, hour, minute);
  const plans = [current];
  if (year - 1 >= MIN_YEAR) plans.push(yearPlan(zone, year - 1));

  for (const plan of plans) {
    const interval = planInterval(plan);
    if (!interval) continue;
    if (when >= interval.startMs && when < interval.endMs) {
      return { dst: true, kind: plan.kind, exception: plan.exception || null };
    }
  }
  return { dst: false, kind: 'standard' };
}

// 一个年安排若按通用规则本应走出的区间（用于判断停行年份本应处于夏令时的时段）
function genericRuleInterval(zone, year) {
  const plan = {
    kind: 'rule',
    year,
    startMs: resolveRuleDate(zone.dstStart, year),
    endMs: resolveRuleDate(zone.dstEnd, year),
    startPart: zone.dstStart,
    endPart: zone.dstEnd,
  };
  return planInterval(plan);
}

// 把名义上的当地夏令时区间换成基准（UTC）绝对时刻区间：
// 开始之前走标准偏移，结束之前走夏令时偏移
function intervalToUtc(zone, interval) {
  return {
    startUtcMs: interval.startMs - zone.offsetMinutes * 60000,
    endUtcMs: interval.endMs - zone.dstOffsetMinutes * 60000,
    crossYear: interval.crossYear,
  };
}

// 给定一个基准（UTC）绝对时刻，判断目标时区当时处在夏令时还是标准时间。
// 直接拿绝对时刻与各次切换的 UTC 时刻比较，避开秋季回退那一个重复小时的歧义。
function dstStateAtUtc(zone, utcMs) {
  if (!zone.usesDst) return { dst: false, kind: 'none', exception: null };

  const utcYear = new Date(utcMs).getUTCFullYear();
  const candidateYears = [utcYear, utcYear - 1, utcYear + 1].filter((y) => y >= MIN_YEAR && y <= MAX_YEAR);

  // 先看真正生效的区间（通用规则或改期例外；停行的年份不产生区间）。
  for (const year of candidateYears) {
    const plan = yearPlan(zone, year);
    const interval = planInterval(plan);
    if (!interval) continue;

    // 南半球上一年的区间会跨年延伸到停行年份的年初，这一段要在停行年份元旦截断，
    // 与挂钟口径"停行年份全年标准时间"保持一致；落在被砍尾部的时刻标明停行
    if (interval.crossYear) {
      const nextPlan = yearPlan(zone, year + 1);
      if (nextPlan.kind === 'skipped') {
        const startUtc = interval.startMs - zone.offsetMinutes * 60000;
        const cutUtc = Date.UTC(year + 1, 0, 1) - zone.dstOffsetMinutes * 60000;
        const tailEndUtc = interval.endMs - zone.dstOffsetMinutes * 60000;
        if (utcMs >= startUtc && utcMs < cutUtc) {
          return { dst: true, kind: plan.kind, exception: plan.exception || null };
        }
        if (utcMs >= cutUtc && utcMs < tailEndUtc) {
          return { dst: false, kind: 'skipped', exception: nextPlan.exception };
        }
        continue;
      }
    }

    const absolute = intervalToUtc(zone, interval);
    if (utcMs >= absolute.startUtcMs && utcMs < absolute.endUtcMs) {
      return { dst: true, kind: plan.kind, exception: plan.exception || null };
    }
  }

  // 不在任何真实区间内：若这一时刻本会落在某个停行年份的通用规则区间里，标明例外停行
  for (const year of candidateYears) {
    const plan = yearPlan(zone, year);
    if (plan.kind !== 'skipped') continue;
    const wouldBe = genericRuleInterval(zone, year);
    if (!wouldBe) continue;
    const absolute = intervalToUtc(zone, wouldBe);
    if (utcMs >= absolute.startUtcMs && utcMs < absolute.endUtcMs) {
      return { dst: false, kind: 'skipped', exception: plan.exception };
    }
  }

  return { dst: false, kind: 'standard', exception: null };
}

function dateTimeText(ms) {
  const date = new Date(ms);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}（${WEEKDAY_NAMES[date.getUTCDay()]}）`;
}

function partRuleText(part) {
  return `${MONTH_LABEL[part.month]}${part.week === 'last' ? '最后一个' : `第${part.week}个`}${WEEK_LABEL[part.weekday]} ${pad(part.hour)}:${pad(part.minute)}`;
}

// 单年时刻表，供页面与接口直接展示，并标明走的是通用规则还是年度例外
function yearSchedule(zone, year) {
  const plan = yearPlan(zone, year);
  const base = { year, kind: plan.kind, inEffect: plan.kind !== 'out' };

  if (plan.kind === 'none') {
    return { ...base, summary: '这条档案不实行夏令时', startText: '', endText: '' };
  }
  if (plan.kind === 'out') {
    return { ...base, summary: `${year} 年不在这条档案的生效年份区间内`, startText: '', endText: '' };
  }
  if (plan.kind === 'skipped') {
    return {
      ...base,
      summary: `${year} 年按年度例外停行夏令时，全年使用标准时间`,
      badge: '年度例外·停行',
      startText: '—',
      endText: '—',
      exceptionNote: plan.exception.note || '',
    };
  }

  const moved = plan.kind === 'moved';
  const interval = planInterval(plan);
  const endLabel = dateTimeText(interval.endMs);
  return {
    ...base,
    summary: moved
      ? `${year} 年按年度例外改期，开始与结束改用例外指定的日期时刻`
      : `${year} 年按通用规则推算${interval.crossYear ? '，夏令时跨年，结束落在次年' : ''}`,
    badge: moved ? '年度例外·改期' : '通用规则',
    startText: dateTimeText(interval.startMs),
    endText: endLabel,
    endInNextYear: interval.crossYear,
    startRuleText: moved ? '' : partRuleText(plan.startPart),
    endRuleText: moved ? '' : partRuleText(plan.endPart),
    exceptionNote: moved && plan.exception.note ? plan.exception.note : '',
  };
}

// 连续多年的时刻表，默认覆盖档案生效区间与当前年份附近；调用方给定起止年
function scheduleForYears(zone, fromYear, toYear) {
  const years = [];
  for (let year = fromYear; year <= toYear; year += 1) {
    years.push(yearSchedule(zone, year));
  }
  const exceptionYears = (Array.isArray(zone.dstExceptions) ? zone.dstExceptions : [])
    .filter((item) => item.year >= fromYear && item.year <= toYear)
    .map((item) => item.year);
  return {
    zoneId: zone.id,
    zoneName: zone.name,
    zoneDisplayName: zone.displayName,
    fromYear,
    toYear,
    exceptionYears,
    years,
  };
}

// 例外里一个固定日期时刻点（与通用规则的"第几个星期几"不同，这里是写死的月日时分）。
// 日期要在例外所属那一年真的存在，所以把年份一并传进来校验
function validateFixedPoint(source, fieldPrefix, labels, year) {
  const raw = source && typeof source === 'object' ? source : {};
  const month = Number(raw.month);
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new ApiError(400, 'DST_EX_MONTH_INVALID', `${labels}的月份要填一到十二`, `${fieldPrefix}.month`);
  }
  const day = Number(raw.day);
  if (!Number.isInteger(day) || day < 1 || day > 31) {
    throw new ApiError(400, 'DST_EX_DAY_INVALID', `${labels}的日要填一到三十一`, `${fieldPrefix}.day`);
  }
  const hour = Number(raw.hour);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new ApiError(400, 'DST_EX_HOUR_INVALID', `${labels}的小时要填零到二十三`, `${fieldPrefix}.hour`);
  }
  const minute = Number(raw.minute);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new ApiError(400, 'DST_EX_MINUTE_INVALID', `${labels}的分钟要填零到五十九`, `${fieldPrefix}.minute`);
  }
  // 月份里未必有这一天，例如 2 月 30 号；二月二十九号还要看例外这一年是不是闰年
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new ApiError(400, 'DST_EX_DATE_NOT_EXIST', `${labels}写成了 ${year} 年 ${month} 月不存在的日期，请检查日`, `${fieldPrefix}.day`);
  }
  return { month, day, hour, minute };
}

// 校验一批年度例外。档案的生效年份与是否实行夏令时由入参传进来，保证校验口径一致
function validateExceptions(value, usesDst, fromYear, toYear) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ApiError(400, 'DST_EXCEPTIONS_INVALID', '年度例外要按列表填写', 'dstExceptions');
  }
  // 不实行夏令时的档案写例外没有意义，整体拒绝
  if (!usesDst && value.length > 0) {
    throw new ApiError(400, 'DST_EXCEPTIONS_NOT_ALLOWED', '这条档案不实行夏令时，不能写年度例外', 'dstExceptions');
  }

  const seen = new Set();
  const result = value.map((rawItem, index) => {
    const item = rawItem && typeof rawItem === 'object' ? rawItem : {};
    const field = `dstExceptions[${index}]`;
    const year = Number(item.year);
    if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) {
      throw new ApiError(400, 'DST_EX_YEAR_INVALID', `第 ${index + 1} 条例外的年份要填 ${MIN_YEAR} 到 ${MAX_YEAR} 之间的整数`, `${field}.year`);
    }
    // 年份必须落在档案生效区间内
    if (year < fromYear || (toYear !== null && year > toYear)) {
      const range = toYear === null ? `${fromYear} 年起` : `${fromYear} 至 ${toYear} 年`;
      throw new ApiError(400, 'DST_EX_YEAR_OUT_OF_RANGE', `${year} 年不在档案生效区间（${range}）内，不能给这一年写例外`, `${field}.year`);
    }
    // 同一条档案同一年只能写一次例外
    if (seen.has(year)) {
      throw new ApiError(400, 'DST_EX_YEAR_DUPLICATED', `${year} 年的例外写了两次，同一年只能写一条`, `${field}.year`);
    }
    seen.add(year);

    const disabled = item.disabled === true || item.disabled === 'true';
    let start = null;
    let end = null;
    if (!disabled) {
      start = validateFixedPoint(item.start, `${field}.start`, `${year} 年例外开始`, year);
      end = validateFixedPoint(item.end, `${field}.end`, `${year} 年例外结束`, year);
      // 开始不能挪到结束之后（同一刻开始又结束也没有意义，一并拒绝）
      const startMs = Date.UTC(year, start.month - 1, start.day, start.hour, start.minute);
      const endMs = Date.UTC(year, end.month - 1, end.day, end.hour, end.minute);
      if (startMs >= endMs) {
        throw new ApiError(400, 'DST_EX_RANGE_INVALID', `${year} 年例外把夏令时开始挪到了结束同时刻或之后，区间不成立`, `${field}.end.day`);
      }
    }

    let note = '';
    if (item.note !== undefined && item.note !== null) {
      if (typeof item.note !== 'string') {
        throw new ApiError(400, 'DST_EX_NOTE_INVALID', `${year} 年例外的备注需要是文本`, `${field}.note`);
      }
      if (item.note.length > 100) {
        throw new ApiError(400, 'DST_EX_NOTE_TOO_LONG', `${year} 年例外的备注不能超过 100 个字符`, `${field}.note`);
      }
      note = item.note.trim();
    }

    return { year, disabled, start, end, note };
  });

  result.sort((a, b) => a.year - b.year);
  return result;
}

module.exports = {
  resolveRuleDate,
  yearInEffect,
  yearPlan,
  planInterval,
  isDstAt,
  dstStateAtUtc,
  yearSchedule,
  scheduleForYears,
  validateExceptions,
};
