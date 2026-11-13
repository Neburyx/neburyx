const MIN_YEAR = 1900;
const MAX_YEAR = 2100;
const DATE_SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function isCalendarDate(token: string): boolean {
  const match = DATE_SHAPE.exec(token);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return year >= MIN_YEAR && year <= MAX_YEAR && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}
