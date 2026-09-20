/**
 * Date formatting utility ("Archive" design system mono date)
 */
export function formatDate(timestamp?: number): string {
  if (!timestamp || typeof timestamp !== 'number' || isNaN(timestamp)) return '';
  const d = new Date(timestamp);
  if (isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}.${m}.${day}`;
}

export function formatDateTime(timestamp?: number, includeSeconds = false): string {
  if (!timestamp || typeof timestamp !== 'number' || isNaN(timestamp)) return '';
  const d = new Date(timestamp);
  if (isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (includeSeconds) {
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${y}.${m}.${day} ${hh}:${mm}:${ss}`;
  }
  return `${y}.${m}.${day} ${hh}:${mm}`;
}

export function formatTime(timestamp?: number, includeSeconds = false): string {
  if (!timestamp || typeof timestamp !== 'number' || isNaN(timestamp)) return '';
  const d = new Date(timestamp);
  if (isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (includeSeconds) {
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }
  return `${hh}:${mm}`;
}
