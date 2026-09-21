// 夏令时推算：把通用规则（第几个星期几）落到具体年份的具体时刻，年度例外优先于通用规则。
//
// 约定：
// - 通用规则里开始段的时刻按标准时读（例如美国东部三月第二个周日 02:00 标准时跳成 03:00）；
//   结束段的时刻按夏令时读（十一月第一个周日 02:00 夏令时倒回 01:00 标准时），这也是档案里
//   伦敦“开始一点、结束两点”、悉尼“结束三点”的写法。
// - 南半球开始月份晚于结束月份，开始落在所写年份、结束落在下一年。
// - 内部统一用“标准时挂钟”的毫秒数（wallMs）比较：它等于 UTC 毫秒加上标准偏移，
//   只是一把线性平移的尺子；真正换算成 UTC 时再减去标准偏移。
const { MIN_YEAR, MAX_YEAR } = require('./store');

const MINUTE_MS = 60000;
const DAY_MS = 86400000;
const pad = (num) => String(num).padStart(2, '0');

// 第几个星期几在某一年的具体日期；week 取 1-4 或 'last'
function nthWeekdayDate(year, month, week, weekday, hour, minute) {
  if (week === 'last') {
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate(); // 下个月第 0 天即本月最后一天
    const lastDate = new Date(Date.UTC(year, month - 1, last));
    const diff = (lastDate.getUTCDay() - weekday + 7) % 7;
    return Date.UTC(year, month - 1, last - diff, hour, minute);
  }
  const firstDate = new Date(Date.UTC(year, month - 1, 1));
  const firstWeekday = firstDate.getUTCDay();
  const diff = (weekday - firstWeekday + 7) % 7;
  const day = 1 + diff + (Number(week) - 1) * 7;
  return Date.UTC(year, month - 1, day, hour, minute);
}

// 例外里的具体日期时刻落到标准时挂钟毫秒
function partWallMs(part) {
  return Date.UTC(part.year, part.month - 1, part.day, part.hour, part.minute);
}

function crossYearRule(zone) {
  return zone.usesDst && zone.dstStart && zone.dstEnd && zone.dstStart.month > zone.dstEnd.month;
}

function findException(zone, year) {
  const list = Array.isArray(zone.dstExceptions) ? zone.dstExceptions : [];
  return list.find((item) => item.year === year) || null;
}

// 开始年份为 startYear 的那一段夏令时区间。开始年份落在生效区间外、或这一年例外停做，返回 null
function intervalForStartYear(zone, startYear) {
  if (!zone.usesDst) return null;
  if (startYear < zone.fromYear) return null;
  if (zone.toYear !== null && startYear > zone.toYear) return null;

  const shift = (zone.dstOffsetMinutes - zone.offsetMinutes) * MINUTE_MS;
  const exception = findException(zone, startYear);
  if (exception && exception.disabled) return null;

  let startWall;
  let endWall;
  if (exception) {
    startWall = partWallMs(exception.start);
    // 结束时刻按夏令时读，换回标准时挂钟要减一个拨快量
    endWall = partWallMs(exception.end) - shift;
  } else {
    startWall = nthWeekdayDate(
      startYear, zone.dstStart.month, zone.dstStart.week, zone.dstStart.weekday,
      zone.dstStart.hour, zone.dstStart.minute,
    );
    const endYear = startYear + (crossYearRule(zone) ? 1 : 0);
    const endRaw = nthWeekdayDate(
      endYear, zone.dstEnd.month, zone.dstEnd.week, zone.dstEnd.weekday,
      zone.dstEnd.hour, zone.dstEnd.minute,
    );
    endWall = endRaw - shift;
  }

  return {
    startYear,
    startWall,
    endWall,
    exceptionYear: exception ? startYear : null,
  };
}

// 只按通用规则算某一开始年份的结束挂钟时刻，用来判断停做年份的余波范围
function genericEndWall(zone, startYear) {
  const shift = (zone.dstOffsetMinutes - zone.offsetMinutes) * MINUTE_MS;
  const endYear = startYear + (crossYearRule(zone) ? 1 : 0);
  return nthWeekdayDate(
    endYear, zone.dstEnd.month, zone.dstEnd.week, zone.dstEnd.weekday,
    zone.dstEnd.hour, zone.dstEnd.minute,
  ) - shift;
}

// 在给定挂钟时刻附近把各年的区间列出来，供落在区间外（标准时段）时判断邻近的切换
function intervalsAroundWall(zone, wallMs) {
  const calYear = new Date(wallMs).getUTCFullYear();
  const result = [];
  for (let year = Math.max(MIN_YEAR, calYear - 3); year <= Math.min(MAX_YEAR, calYear + 3); year += 1) {
    const interval = intervalForStartYear(zone, year);
    if (interval) result.push(interval);
  }
  return result;
}

// 某段区间的开始年份若带着年度例外，就回例外年份，用于在结果里标明走的是例外
function coveringInterval(zone, wallMs) {
  const intervals = intervalsAroundWall(zone, wallMs);
  return intervals.find((item) => wallMs >= item.startWall && wallMs < item.endWall) || null;
}

// 标准时段里若通用规则本应处在夏令时，那此刻用标准时正是当年年度例外（停做或改期）的结果。
// 返回造成这一结果的例外年份；通用规则本来就是标准时则返回 null，不硬贴例外标签
function exceptionThatSuppressedDstAtWall(zone, wallMs) {
  const calYear = new Date(wallMs).getUTCFullYear();
  for (let year = Math.max(MIN_YEAR, calYear - 2); year <= Math.min(MAX_YEAR, calYear + 2); year += 1) {
    const exception = findException(zone, year);
    if (!exception) continue;
    const genericStart = nthWeekdayDate(
      year, zone.dstStart.month, zone.dstStart.week, zone.dstStart.weekday,
      zone.dstStart.hour, zone.dstStart.minute,
    );
    const genericEnd = genericEndWall(zone, year);
    if (wallMs >= genericStart && wallMs < genericEnd) return year;
  }
  return null;
}

// 某个 UTC 时刻这条档案实际生效的偏移，以及是否处在夏令时、是否由年度例外说了算
function effectiveOffsetAtUtc(zone, utcMs) {
  if (!zone.usesDst) {
    return { offsetMinutes: zone.offsetMinutes, dstActive: false, exceptionYear: null };
  }
  const wallMs = utcMs + zone.offsetMinutes * MINUTE_MS;
  const active = coveringInterval(zone, wallMs);
  if (active) {
    return {
      offsetMinutes: zone.dstOffsetMinutes,
      dstActive: true,
      exceptionYear: active.exceptionYear,
    };
  }
  return {
    offsetMinutes: zone.offsetMinutes,
    dstActive: false,
    exceptionYear: exceptionThatSuppressedDstAtWall(zone, wallMs),
  };
}

// 把来源时区填的当地挂钟时刻折成 UTC。春天拨快会有一段挂钟不存在（跳过），
// 秋天拨回会有一段挂钟出现两次（重复）：不存在的按拨快后处理，重复的按标准时处理
function resolveWallInput(zone, wallMs) {
  if (!zone.usesDst) {
    return {
      utcMs: wallMs - zone.offsetMinutes * MINUTE_MS,
      kind: 'normal',
      appliedOffsetMinutes: zone.offsetMinutes,
      dstAssumed: false,
      exceptionYear: null,
      message: '',
    };
  }
  const asStandard = wallMs - zone.offsetMinutes * MINUTE_MS;
  const asDaylight = wallMs - zone.dstOffsetMinutes * MINUTE_MS;
  const standardInfo = effectiveOffsetAtUtc(zone, asStandard);
  const daylightInfo = effectiveOffsetAtUtc(zone, asDaylight);
  const standardValid = standardInfo.offsetMinutes === zone.offsetMinutes;
  const daylightValid = daylightInfo.offsetMinutes === zone.dstOffsetMinutes;
  const base = formatWall(wallMs);

  if (standardValid && !daylightValid) {
    return {
      utcMs: asStandard, kind: 'normal',
      appliedOffsetMinutes: zone.offsetMinutes, dstAssumed: false,
      exceptionYear: standardInfo.exceptionYear, message: '',
    };
  }
  if (daylightValid && !standardValid) {
    return {
      utcMs: asDaylight, kind: 'normal',
      appliedOffsetMinutes: zone.dstOffsetMinutes, dstAssumed: true,
      exceptionYear: daylightInfo.exceptionYear, message: '',
    };
  }
  if (!standardValid && !daylightValid) {
    // 春天跳过的空当：按拨快后的夏令时折成 UTC
    return {
      utcMs: asDaylight, kind: 'skipped',
      appliedOffsetMinutes: zone.dstOffsetMinutes, dstAssumed: true,
      exceptionYear: daylightInfo.exceptionYear,
      message: `输入的 ${base} 落在拨快时跳过的空当，按拨快后的夏令时折算`,
    };
  }
  // 秋天重复的一段：按标准时（拨回后）折成 UTC
  return {
    utcMs: asStandard, kind: 'repeated',
    appliedOffsetMinutes: zone.offsetMinutes, dstAssumed: false,
    exceptionYear: standardInfo.exceptionYear,
    message: `输入的 ${base} 在拨回时会出现两次，按拨回后的标准时折算`,
  };
}

// 挂钟毫秒格式化成 YYYY-MM-DD HH:mm（用 UTC 字段，因为这把尺子本身是平移出来的）
function formatWall(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} `
    + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function formatUtc(ms) {
  return formatWall(ms);
}

// 一条年度例外的文字说明，列表与时刻表都用它
function exceptionText(exception) {
  if (!exception) return '';
  if (exception.disabled) return `${exception.year} 年停做夏令时`;
  const s = exception.start;
  const e = exception.end;
  return `${exception.year} 年例外：${s.year}-${pad(s.month)}-${pad(s.day)} ${pad(s.hour)}:${pad(s.minute)} 起，`
    + `${e.year}-${pad(e.month)}-${pad(e.day)} ${pad(e.hour)}:${pad(e.minute)} 止`;
}

// 某一年的切换时刻表：两条切换（开始、结束）各自注明来自通用规则还是年度例外
function transitionsForYear(zone, year) {
  if (!zone.usesDst) {
    return { year, usesDst: false, inRange: true, events: [] };
  }
  const inRange = year >= zone.fromYear && (zone.toYear === null || year <= zone.toYear);
  const shift = (zone.dstOffsetMinutes - zone.offsetMinutes) * MINUTE_MS;
  const crossYear = crossYearRule(zone);

  // 北半球：开始与结束都来自开始年份等于 year 的区间；
  // 南半球：year 年四月的结束来自开始年份 year-1 的区间，十月的开始来自 year
  const startInterval = inRange ? intervalForStartYear(zone, year) : null;
  const endInterval = !crossYear
    ? startInterval
    : (year - 1 >= zone.fromYear && (zone.toYear === null || year - 1 <= zone.toYear)
      ? intervalForStartYear(zone, year - 1)
      : null);

  const events = [];

  if (crossYear && endInterval) {
    events.push(buildEndEvent(zone, endInterval, shift));
  }
  if (startInterval) {
    events.push(buildStartEvent(zone, startInterval, shift));
  } else if (inRange) {
    const exception = findException(zone, year);
    if (exception && exception.disabled) {
      events.push({
        kind: 'start', year, omitted: true, reason: 'disabled',
        clockText: '—', utcText: '—', exceptionYear: year,
        message: `${year} 年按例外停做夏令时，全年使用标准时间`,
      });
    }
  }
  if (!crossYear && endInterval) {
    events.push(buildEndEvent(zone, endInterval, shift));
  }
  if (crossYear && !endInterval && inRange) {
    const prevException = findException(zone, year - 1);
    if (prevException && prevException.disabled) {
      events.push({
        kind: 'end', year, omitted: true, reason: 'disabled',
        clockText: '—', utcText: '—', exceptionYear: year - 1,
        message: `${year - 1} 年按例外停做夏令时，${year} 年没有夏令时需要结束`,
      });
    }
  }

  return { year, usesDst: true, inRange, events };
}

function buildStartEvent(zone, interval, shift) {
  const before = interval.startWall;
  const after = before + shift;
  const fromException = interval.exceptionYear !== null;
  return {
    kind: 'start',
    year: interval.startYear,
    omitted: false,
    exceptionYear: interval.exceptionYear,
    ruleSource: fromException ? 'exception' : 'generic',
    clockBefore: formatWall(before),
    clockAfter: formatWall(after),
    clockText: `${formatWall(before)} → ${formatWall(after)}`,
    utcText: formatUtc(before - zone.offsetMinutes * MINUTE_MS),
    offsetBeforeMinutes: zone.offsetMinutes,
    offsetAfterMinutes: zone.dstOffsetMinutes,
    message: fromException
      ? `${interval.startYear} 年按年度例外改期：挂钟从 ${formatWall(before)} 拨到 ${formatWall(after)}`
      : `${interval.startYear} 年按通用规则：挂钟从 ${formatWall(before)} 拨到 ${formatWall(after)}`,
  };
}

function buildEndEvent(zone, interval, shift) {
  const before = interval.endWall + shift; // 结束时刻按夏令时读
  const after = interval.endWall;
  const fromException = interval.exceptionYear !== null;
  return {
    kind: 'end',
    year: crossYearRule(zone) ? interval.startYear + 1 : interval.startYear,
    exceptionYear: interval.exceptionYear,
    ruleSource: fromException ? 'exception' : 'generic',
    clockBefore: formatWall(before),
    clockAfter: formatWall(after),
    clockText: `${formatWall(before)} → ${formatWall(after)}`,
    utcText: formatUtc(after - zone.offsetMinutes * MINUTE_MS),
    offsetBeforeMinutes: zone.dstOffsetMinutes,
    offsetAfterMinutes: zone.offsetMinutes,
    message: fromException
      ? `结束于按年度例外改期后的 ${formatWall(before)}，挂钟拨回 ${formatWall(after)}`
      : `按通用规则结束于 ${formatWall(before)}，挂钟拨回 ${formatWall(after)}`,
  };
}

function isValidYear(year) {
  return Number.isInteger(year) && year >= MIN_YEAR && year <= MAX_YEAR;
}

module.exports = {
  MIN_YEAR,
  MAX_YEAR,
  DAY_MS,
  nthWeekdayDate,
  crossYearRule,
  findException,
  intervalForStartYear,
  effectiveOffsetAtUtc,
  resolveWallInput,
  transitionsForYear,
  exceptionText,
  formatWall,
  isValidYear,
};
