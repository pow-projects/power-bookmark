/**
 * Creates a drag preview for dragged bookmark(s) (single or multiple) as a small, translucent floating chip (badge).
 * @param e HTML5 DragEvent
 * @param title Bookmark title (or URL)
 * @param count Total number of dragged bookmarks
 */
export function setBookmarkDragImage(
  e: DragEvent,
  title: string,
  count: number
): void {
  if (!e.dataTransfer || typeof document === 'undefined') return;

  const ghost = document.createElement('div');
  ghost.className = 'bookmark-drag-ghost';
  ghost.style.position = 'fixed';
  ghost.style.top = '-1000px';
  ghost.style.left = '-1000px';
  ghost.style.display = 'inline-flex';
  ghost.style.alignItems = 'center';
  ghost.style.gap = '6px';
  ghost.style.padding = '4px 10px';
  ghost.style.maxWidth = '220px';
  ghost.style.height = '28px';
  ghost.style.boxSizing = 'border-box';
  ghost.style.background = 'rgba(28, 28, 34, 0.88)';
  ghost.style.color = '#ffffff';
  ghost.style.border = '1px solid rgba(255, 255, 255, 0.2)';
  ghost.style.borderRadius = '14px';
  ghost.style.fontSize = '11px';
  ghost.style.fontWeight = '500';
  ghost.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.35)';
  ghost.style.zIndex = '99999';
  ghost.style.pointerEvents = 'none';
  ghost.style.userSelect = 'none';
  ghost.style.fontFamily = 'var(--font-primary, system-ui, sans-serif)';

  // Icon
  const icon = document.createElement('span');
  icon.textContent = '🔖';
  icon.style.fontSize = '12px';
  icon.style.lineHeight = '1';
  ghost.appendChild(icon);

  // Title
  const titleSpan = document.createElement('span');
  titleSpan.textContent = title || i18n.t('common.bookmark');
  titleSpan.style.overflow = 'hidden';
  titleSpan.style.textOverflow = 'ellipsis';
  titleSpan.style.whiteSpace = 'nowrap';
  titleSpan.style.maxWidth = count > 1 ? '120px' : '170px';
  ghost.appendChild(titleSpan);

  // Multi-item count badge
  if (count > 1) {
    const badge = document.createElement('span');
    badge.textContent = `+${count - 1}`;
    badge.style.background = 'var(--color-primary, #8c2424)';
    badge.style.color = '#ffffff';
    badge.style.padding = '1px 5px';
    badge.style.borderRadius = '8px';
    badge.style.fontSize = '10px';
    badge.style.fontWeight = '700';
    badge.style.fontFamily = 'var(--font-mono, monospace)';
    badge.style.lineHeight = '1.2';
    ghost.appendChild(badge);
  }

  document.body.appendChild(ghost);
  e.dataTransfer.setDragImage(ghost, 14, 14);

  setTimeout(() => {
    if (ghost.parentNode) {
      ghost.parentNode.removeChild(ghost);
    }
  }, 0);
}
