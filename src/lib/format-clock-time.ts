const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// The one clock-time formatter: "2:36 PM" today, "Sep 20, 2:36 PM" on any other day, in the
// viewer's local time. Built by hand rather than through Intl so the output never drifts
// with the runtime's ICU data (newer ICU puts a narrow no-break space before AM/PM).
// Durations are not clock times - they stay m:ss elsewhere.
export function formatClockTime(value: string | Date, now: Date = new Date()): string {
  const date = typeof value === 'string' ? new Date(value) : value
  const hours = date.getHours()
  const time = `${hours % 12 === 0 ? 12 : hours % 12}:${date.getMinutes().toString().padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`
  const sameDay =
    date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()
  return sameDay ? time : `${MONTHS[date.getMonth()]} ${date.getDate()}, ${time}`
}
