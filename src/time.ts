// Wall-clock times in 24-hour format (no AM/PM), whatever the browser's locale prefers.
const withSeconds = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const withoutSeconds = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** 14:05:09 */
export const clock = (ms: number) => withSeconds.format(ms);
/** 14:05 */
export const clockShort = (ms: number) => withoutSeconds.format(ms);
