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
