<script lang="ts">
  /**
   * Folder tree view for management page (pure presentation component)
   *
   * - Renders only the folder list passed via props without browser API / DB access.
   * - value is based on the folder's original path ('Bookmarks Bar/Community') — compatible with existing FolderSelect filter (value=path).
   * - System root folders (Bookmarks Bar, etc.) are not displayed as nodes; their children are promoted to top level.
   * - counts: key=folder normalized path (system root removed, normalizeFolderPath), value=bookmark count including folder+subfolders. 0/missing preserves empty placeholder (prevents layout shift).
   */
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import Icon from '../shared/Icon.svelte';
  import { normalizeFolderPath, isSystemRootTitle } from '../../lib/bookmarks/bookmark-manager';

  export let folders: { id: string; title: string; path: string; parentId?: string }[] = [];
  export let value: string = ''; // Selected folder path ('' = all)
  export let rootLabel: string = '';
  export let counts: Record<string, number> = {}; // key=folder original path -> (folder+subfolders) bookmark count
  export let rootCount: number = 0; // Total bookmark count ('' = displayed on all-folders row)

  $: effectiveRootLabel = rootLabel || i18n.t('folders.allFolders');

  const dispatch = createEventDispatcher<{
    change: { value: string };
    delete: { value: string };
    clean: { value: string; folderId?: string; title?: string };
    edit: { value: string; id: string; folderId: string; title: string; path: string; parentId?: string };
    reorder: { value: string; folderId: string; parentId?: string; order: string[] };
    move: {
      value: string;
      folderId: string;
      targetParentId: string;
      targetPath: string;
      position?: 'before' | 'after' | 'inside';
      referenceFolderId?: string;
      targetIndex?: number;
    };
    dropBookmarks: {
      bookmarkIds: number[];
      targetFolder: { id: string; path: string; title: string };
    };
  }>();

  interface TreeNode {
    id: string;
    title: string;
    path: string;
    parentId?: string;
  }

  /** Folders to display in tree (including system roots such as Bookmarks Bar) */
  $: displayNodes = folders;

  /** parentId -> children map. Preserves input order since getFolders() guarantees DFS order */
  $: childrenByParent = (() => {
    const map = new Map<string, TreeNode[]>();
    for (const node of displayNodes) {
      if (node.parentId) {
        const siblings = map.get(node.parentId) ?? [];
        siblings.push(node);
        map.set(node.parentId, siblings);
      }
    }
    return map;
  })();

  /** Set of displayed node IDs */
  $: displayNodeIds = new Set(displayNodes.map((n) => n.id));

  /** Root nodes = parent not among display nodes or parent unspecified */
  $: rootNodes = displayNodes.filter((node) => !node.parentId || !displayNodeIds.has(node.parentId));

  /** Original path and normalized path -> node lookup map */
  $: byNormPath = (() => {
    const map = new Map<string, TreeNode>();
    for (const node of displayNodes) {
      map.set(node.path, node);
      const norm = normalizeFolderPath(node.path);
      if (norm) map.set(norm, node);
    }
    return map;
  })();

  // ---- Collapse/expand state (path-based Set) ----
  let expanded = new Set<string>();
  let userExpanded = new Set<string>(); // Paths expanded by user via chevron
  let userCollapsed = new Set<string>(); // Paths collapsed by user via chevron

  /** List of display node paths corresponding to ancestors of value path (original path segment prefix matching) */
  function ancestorPathsOf(valuePath: string, byNorm: Map<string, TreeNode>): string[] {
    if (!valuePath) return [];
    const segments = valuePath.split('/').filter(Boolean);
    const ancestors: string[] = [];
    let acc = '';
    for (let i = 0; i < segments.length - 1; i += 1) {
      acc = acc ? `${acc}/${segments[i]}` : segments[i];
      const ancestor = byNorm.get(acc);
      if (ancestor) ancestors.push(ancestor.path);
    }
    return ancestors;
  }

  /** Auto-expanded targets: all depths 0-2 (levels 1-3) + all ancestors of selected folder (value) */
  $: autoExpanded = (() => {
    const set = new Set<string>();
    const walk = (nodes: TreeNode[], depth: number) => {
      for (const node of nodes) {
        if (depth < 3) {
          set.add(node.path);
          walk(childrenByParent.get(node.id) ?? [], depth + 1);
        }
      }
    };
    walk(rootNodes, 0);
    if (value) {
      for (const path of ancestorPathsOf(value, byNormPath)) set.add(path);
    }
    return set;
  })();

  /** On value change, clear user collapsed state for ancestors of new selection -> ensure selected folder is always visible in tree */
  let lastValue = '';
  $: if (value !== lastValue) {
    lastValue = value;
    const ancestors = value ? ancestorPathsOf(value, byNormPath) : [];
    if (ancestors.length > 0) {
      const nextCollapsed = new Set(userCollapsed);
      let changed = false;
      for (const path of ancestors) {
        if (nextCollapsed.delete(path)) changed = true;
      }
      if (changed) userCollapsed = nextCollapsed;
    }
  }

  /** Effective expanded state = autoExpanded ∪ userExpanded - userCollapsed */
  $: expanded = (() => {
    const set = new Set(autoExpanded);
    for (const path of userExpanded) set.add(path);
    for (const path of userCollapsed) set.delete(path);
    return set;
  })();

  function toggleExpand(path: string) {
    const nextExpanded = new Set(userExpanded);
    const nextCollapsed = new Set(userCollapsed);
    if (expanded.has(path)) {
      nextExpanded.delete(path);
      nextCollapsed.add(path);
    } else {
      nextCollapsed.delete(path);
      nextExpanded.add(path);
    }
    userExpanded = nextExpanded;
    userCollapsed = nextCollapsed;
  }

  function select(path: string) {
    value = path;
    dispatch('change', { value: path });
  }

  function handleEdit(node: TreeNode) {
    if (isSystemRootTitle(node.title)) return;
    dispatch('edit', {
      value: node.path,
      id: node.id,
      folderId: node.id,
      title: node.title,
      path: node.path,
      parentId: node.parentId
    });
  }

  /** Right delete (X) click — separated from row selection and dispatched as a separate event */
  function handleDelete(path: string) {
    // Defense-in-depth: Re-block system root folders in addition to not rendering button
    if (isSystemRootTitle(byNormPath.get(path)?.title)) return;
    dispatch('delete', { value: path });
  }

  /** Clean empty folders click — dispatched for system root folders or all-folders root */
  function handleClean(path: string, folderId?: string, title?: string) {
    dispatch('clean', { value: path, folderId, title: title || byNormPath.get(path)?.title || '' });
  }

  // ---- Folder reordering & moving via drag ----
  type DropPosition = 'before' | 'inside' | 'after';

  interface DropTargetResult {
    isInvalidZone?: boolean;
    node?: TreeNode & { depth: number };
    position?: DropPosition;
    dropLineTop?: number | null;
    dropLineLeft?: number;
  }

  let treeScrollEl: HTMLElement;
  let isDragging = false;
  let dragNodeId: string | null = null;
  let dragSiblings: TreeNode[] = []; // Sibling list at drag start (display order)
  let dragFromIndex = -1; // Index at drag start (within sibling list)
  let dragDescendantIds = new Set<string>(); // Set of descendant IDs of drag node — for cycle prevention (computed via BFS on onDragStart)
  let insertPos = -1; // Current drop insert position (within sibling list, 0..len)
  let dropLineTop: number | null = null; // Drop indicator vertical px
  let dropLineLeft: number = 0; // Drop indicator horizontal px (8 + depth * 16)
  let dropTargetId: string | null = null; // Target folder ID for inside move
  let dropTargetPath: string | null = null; // Target folder path for inside move
  let dropPosition: DropPosition | null = null; // 'before' | 'inside' | 'after'
  let currentDropTarget: (TreeNode & { depth: number }) | null = null;
  let isInvalidDropZone = false;

  function rowElOf(id: string): HTMLElement | null {
    return treeScrollEl?.querySelector<HTMLElement>(`.tree-item[data-folder-id="${id}"]`) ?? null;
  }

  function siblingRowCenterY(id: string): number {
    const el = rowElOf(id);
    if (!el) return -Infinity;
    const r = el.getBoundingClientRect();
    return r.top + r.height / 2;
  }

  function computeInsertPos(clientY: number): number {
    const others = dragSiblings.filter((s) => s.id !== dragNodeId);
    let pos = 0;
    for (const s of others) {
      if (siblingRowCenterY(s.id) < clientY) pos += 1;
    }
    return pos;
  }

  function updateDropLine() {
    if (!treeScrollEl) {
      dropLineTop = null;
      return;
    }
    const others = dragSiblings.filter((s) => s.id !== dragNodeId);
    let topPx: number | null = null;
    if (others.length > 0) {
      if (insertPos >= others.length) {
        // End of list -> below last sibling row
        const last = rowElOf(others[others.length - 1].id);
        if (last) topPx = last.offsetTop + (last.offsetHeight || 32);
      } else {
        const at = rowElOf(others[insertPos].id);
        if (at) topPx = at.offsetTop;
      }
    }
    dropLineTop = topPx;
    const dragNode = flatNodes.find((n) => n.id === dragNodeId);
    dropLineLeft = 8 + (dragNode?.depth ?? 0) * 16;
  }

  function onDragStart(e: PointerEvent, node: TreeNode) {
    if (e.button !== 0) return;
    // Exclude system roots (Bookmarks Bar, etc.) from reordering
    if (isSystemRootTitle(node.title)) return;
    e.preventDefault();
    e.stopPropagation();
    const siblings = displayNodes.filter(
      (n) => (n.parentId ?? undefined) === (node.parentId ?? undefined)
    );
    dragNodeId = node.id;
    dragSiblings = siblings;
    dragFromIndex = siblings.findIndex((s) => s.id === node.id);
    // For cycle prevention: precompute the set of descendant IDs of the dragged node.
    const desc = new Set<string>();
    const queue = [...(childrenByParent.get(node.id) ?? [])];
    while (queue.length > 0) {
      const child = queue.shift()!;
      desc.add(child.id);
      queue.push(...(childrenByParent.get(child.id) ?? []));
    }
    dragDescendantIds = desc;
    insertPos = dragFromIndex;
    isDragging = true;
    dropLineTop = null;
    dropLineLeft = 0;
    dropTargetId = null;
    dropTargetPath = null;
    dropPosition = null;
    currentDropTarget = null;
    isInvalidDropZone = false;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    updateDropLine();
  }

  /** 3-Zone Hit-Testing: returns before / inside / after drop target or invalid zone */
  function findDropTarget(clientX: number, clientY: number): DropTargetResult | null {
    if (!isDragging || !dragNodeId || !treeScrollEl) return null;

    const dragNode = displayNodes.find((n) => n.id === dragNodeId);
    if (!dragNode) return null;

    const rows = treeScrollEl.querySelectorAll<HTMLElement>('.tree-item[data-folder-id]');
    for (const el of rows) {
      const rect = el.getBoundingClientRect();
      if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
        continue;
      }

      const id = el.dataset.folderId;
      if (!id) continue;

      // 1. Self or descendant -> Invalid Zone: disable indicator and block drop
      if (id === dragNodeId || dragDescendantIds.has(id)) {
        return { isInvalidZone: true };
      }

      const candidate = flatNodes.find((n) => n.id === id);
      if (!candidate) continue;

      const isSystemRoot =
        isSystemRootTitle(candidate.title) ||
        candidate.parentId === '0' ||
        candidate.parentId === 'root' ||
        candidate.parentId === 'root________' ||
        !candidate.parentId;

      const height = rect.height || 32;
      const y = clientY - rect.top;
      const ratio = y / height;

      let position: DropPosition;

      if (isSystemRoot) {
        // System roots cannot have siblings; force inside
        position = 'inside';
      } else {
        const isExpanded = expanded.has(candidate.path) || expanded.has(candidate.id);
        const hasChild = hasChildren(candidate);

        if (isExpanded && hasChild) {
          // Expanded parent: upper 25% is before, lower 75% is inside
          if (ratio < 0.25) {
            position = 'before';
          } else {
            position = 'inside';
          }
        } else {
          if (ratio < 0.25) {
            position = 'before';
          } else if (ratio > 0.75) {
            position = 'after';
          } else {
            position = 'inside';
          }
        }
      }

      // Root sibling prevention: cannot become sibling of root
      if (position === 'before' || position === 'after') {
        if (
          candidate.parentId === '0' ||
          candidate.parentId === 'root' ||
          candidate.parentId === 'root________' ||
          !candidate.parentId
        ) {
          position = 'inside';
        }
      }

      const lineLeft = 8 + (candidate.depth ?? 0) * 16;
      let lineTop: number | null = null;
      if (position === 'before') {
        lineTop = el.offsetTop;
      } else if (position === 'after') {
        lineTop = el.offsetTop + (el.offsetHeight || rect.height || 32);
      }

      return {
        isInvalidZone: false,
        node: candidate,
        position,
        dropLineTop: lineTop,
        dropLineLeft: lineLeft
      };
    }

    return null;
  }

  function onDragMove(e: PointerEvent) {
    if (!isDragging || !dragNodeId) return;
    e.preventDefault();

    const hit = findDropTarget(e.clientX, e.clientY);

    if (hit?.isInvalidZone) {
      isInvalidDropZone = true;
      currentDropTarget = null;
      dropTargetId = null;
      dropTargetPath = null;
      dropPosition = null;
      dropLineTop = null;
    } else if (hit && hit.node && hit.position) {
      isInvalidDropZone = false;
      currentDropTarget = hit.node;
      dropPosition = hit.position;

      if (hit.position === 'inside') {
        dropTargetId = hit.node.id;
        dropTargetPath = hit.node.path;
        dropLineTop = null;
      } else {
        dropTargetId = null;
        dropTargetPath = null;
        dropLineTop = hit.dropLineTop ?? null;
        dropLineLeft = hit.dropLineLeft ?? 0;
      }
    } else {
      isInvalidDropZone = false;
      currentDropTarget = null;
      dropTargetId = null;
      dropTargetPath = null;
      dropPosition = null;
      insertPos = computeInsertPos(e.clientY);
      updateDropLine();
    }
  }

  function onDragEnd(e: PointerEvent) {
    if (!isDragging || !dragNodeId) return;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);

    const nodeId = dragNodeId;
    const fromIndex = dragFromIndex;
    const siblings = dragSiblings;
    const target = insertPos;
    const invalid = isInvalidDropZone;
    const hitTarget = currentDropTarget;
    const pos = dropPosition;

    dragNodeId = null;
    dragSiblings = [];
    dragFromIndex = -1;
    dragDescendantIds = new Set();
    insertPos = -1;
    isDragging = false;
    dropLineTop = null;
    dropLineLeft = 0;
    dropTargetId = null;
    dropTargetPath = null;
    dropPosition = null;
    currentDropTarget = null;
    isInvalidDropZone = false;

    // 1. Invalid zone -> early exit
    if (invalid) return;

    const moved = siblings.find((s) => s.id === nodeId);
    if (!moved) return;

    // 2. Dropped on a valid target node
    if (hitTarget && pos) {
      if (pos === 'inside') {
        dispatch('move', {
          value: moved.path,
          folderId: nodeId,
          targetParentId: hitTarget.id,
          targetPath: hitTarget.path,
          position: 'inside',
          referenceFolderId: hitTarget.id
        });
        return;
      }

      if (pos === 'before' || pos === 'after') {
        const isSameParent = (hitTarget.parentId ?? undefined) === (moved.parentId ?? undefined);
        if (isSameParent) {
          const others = siblings.filter((s) => s.id !== nodeId);
          const targetIdx = others.findIndex((s) => s.id === hitTarget.id);
          if (targetIdx !== -1) {
            const insertIdx = pos === 'before' ? targetIdx : targetIdx + 1;
            const newOrder = [...others.slice(0, insertIdx), moved, ...others.slice(insertIdx)];
            const order = newOrder.map((s) => s.id);
            if (order.join(',') !== siblings.map((s) => s.id).join(',')) {
              dispatch('reorder', {
                value: moved.path,
                folderId: nodeId,
                parentId: moved.parentId,
                order
              });
            }
          }
          return;
        } else {
          const destSiblings = displayNodes.filter(
            (n) => (n.parentId ?? undefined) === (hitTarget.parentId ?? undefined)
          );
          const refIdx = destSiblings.findIndex((s) => s.id === hitTarget.id);
          const targetIndex = pos === 'before' ? Math.max(0, refIdx) : refIdx + 1;

          dispatch('move', {
            value: moved.path,
            folderId: nodeId,
            targetParentId: hitTarget.parentId!,
            targetPath: hitTarget.path,
            position: pos,
            referenceFolderId: hitTarget.id,
            targetIndex
          });
          return;
        }
      }
    }

    // 3. Fallback: no row was hit, use insertPos for sibling reorder
    if (fromIndex === target) return;
    const others = siblings.filter((s) => s.id !== nodeId);
    const newOrder = [...others.slice(0, target), moved, ...others.slice(target)];
    const order = newOrder.map((s) => s.id);
    if (order.join(',') === siblings.map((s) => s.id).join(',')) return;
    dispatch('reorder', {
      value: moved.path,
      folderId: nodeId,
      parentId: moved.parentId,
      order
    });
  }

  function onDragCancel(e: PointerEvent) {
    if (!isDragging || !dragNodeId) return;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    dragNodeId = null;
    dragSiblings = [];
    dragFromIndex = -1;
    dragDescendantIds = new Set();
    insertPos = -1;
    isDragging = false;
    dropLineTop = null;
    dropLineLeft = 0;
    dropTargetId = null;
    dropTargetPath = null;
    dropPosition = null;
    currentDropTarget = null;
    isInvalidDropZone = false;
  }

  // ---- Bookmark HTML5 drag and drop move ----
  let dropBookmarkTargetId: string | null = null;
  let hoverExpandTimer: any = null;

  onDestroy(() => {
    if (hoverExpandTimer) {
      clearTimeout(hoverExpandTimer);
      hoverExpandTimer = null;
    }
  });

  function handleBookmarkDragOver(e: DragEvent, node: TreeNode) {
    if (!e.dataTransfer) return;
    const types = e.dataTransfer.types ? Array.from(e.dataTransfer.types) : [];
    const isBookmarkDrag = types.includes('application/x-powerbookmark-ids');
    if (!isBookmarkDrag) return;

    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    if (dropBookmarkTargetId !== node.id) {
      dropBookmarkTargetId = node.id;
      if (hoverExpandTimer) {
        clearTimeout(hoverExpandTimer);
        hoverExpandTimer = null;
      }

      // Spring-loaded: auto-expand on 600ms hover if folder has children and is collapsed
      if (hasChildren(node) && !expanded.has(node.path)) {
        hoverExpandTimer = setTimeout(() => {
          if (dropBookmarkTargetId === node.id) {
            const nextExpanded = new Set(userExpanded);
            nextExpanded.add(node.path);
            userExpanded = nextExpanded;
          }
        }, 600);
      }
    }
  }

  function handleBookmarkDragLeave(e: DragEvent, node: TreeNode) {
    if (e.relatedTarget && (e.currentTarget as HTMLElement)?.contains(e.relatedTarget as Node)) {
      return;
    }
    if (dropBookmarkTargetId === node.id) {
      dropBookmarkTargetId = null;
      if (hoverExpandTimer) {
        clearTimeout(hoverExpandTimer);
        hoverExpandTimer = null;
      }
    }
  }

  function handleBookmarkDrop(e: DragEvent, node: TreeNode) {
    if (hoverExpandTimer) {
      clearTimeout(hoverExpandTimer);
      hoverExpandTimer = null;
    }
    dropBookmarkTargetId = null;

    if (!e.dataTransfer) return;
    const rawData = e.dataTransfer.getData('application/x-powerbookmark-ids');
    if (!rawData) return;

    try {
      const bookmarkIds = JSON.parse(rawData);
      if (Array.isArray(bookmarkIds) && bookmarkIds.length > 0) {
        e.preventDefault();
        dispatch('dropBookmarks', {
          bookmarkIds,
          targetFolder: {
            id: node.id,
            path: node.path,
            title: node.title
          }
        });
      }
    } catch (err) {
      console.error('Failed to parse bookmark drop payload:', err);
    }
  }

  /** Enter/Space keyboard selection — operates only when focus is on the row itself (tabindex=0) (prevents collision with chevron button) */
  function handleKeydown(e: KeyboardEvent, path: string) {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      select(path);
    }
  }

  /** DFS display order reflecting expanded state (including depth) */
  $: flatNodes = (() => {
    const out: (TreeNode & { depth: number })[] = [];
    const seen = new Set<string>();
    const walk = (nodes: TreeNode[], depth: number) => {
      for (const node of nodes) {
        if (seen.has(node.id)) continue;
        seen.add(node.id);
        out.push({ ...node, depth });
        if (expanded.has(node.path) || expanded.has(node.id)) {
          walk(childrenByParent.get(node.id) ?? [], depth + 1);
        }
      }
    };
    walk(rootNodes, 0);
    return out;
  })();

  function hasChildren(node: TreeNode): boolean {
    return (childrenByParent.get(node.id)?.length ?? 0) > 0;
  }
</script>

<div class="folder-tree">
  <div class="tree-scroll" role="tree" aria-label={effectiveRootLabel} bind:this={treeScrollEl} class:dragging={isDragging}>
    <!-- All (clear selection) -->
    <div
      class="tree-item root-item"
      class:active={value === ''}
      role="treeitem"
      aria-selected={value === ''}
      aria-level="1"
      tabindex="0"
      on:click={() => select('')}
      on:keydown={(e) => handleKeydown(e, '')}
    >
      <span class="chevron-slot" aria-hidden="true"></span>
      <span class="tree-label">{effectiveRootLabel}</span>
      <span class="tree-count" class:visible={rootCount > 0}>{rootCount > 0 ? rootCount : ''}</span>
      <button
        type="button"
        class="row-action row-clean"
        aria-label="{effectiveRootLabel} {i18n.t('folders.cleanEmptyFolders')}"
        title={i18n.t('folders.cleanEmptyFolders')}
        on:click|stopPropagation={() => handleClean('', undefined, effectiveRootLabel)}
      >
        <Icon name="trash-2" size={14} />
      </button>
    </div>

    {#each flatNodes as node (node.id)}
      {@const countVal = counts[node.path] ?? counts[normalizeFolderPath(node.path)] ?? 0}
      <div
        class="tree-item"
        class:active={value === node.path}
        class:dragging-target={isDragging && dragNodeId === node.id}
        class:drop-target={isDragging && dropTargetId === node.id}
        class:bookmark-drop-target={dropBookmarkTargetId === node.id}
        data-folder-id={node.id}
        role="treeitem"
        aria-selected={value === node.path}
        aria-level={node.depth + 1}
        aria-expanded={hasChildren(node) ? expanded.has(node.path) : undefined}
        style="padding-left: {8 + node.depth * 16}px"
        tabindex="0"
        on:click={() => select(node.path)}
        on:keydown={(e) => handleKeydown(e, node.path)}
        on:dragover={(e) => handleBookmarkDragOver(e, node)}
        on:dragleave={(e) => handleBookmarkDragLeave(e, node)}
        on:drop={(e) => handleBookmarkDrop(e, node)}
      >
        {#if hasChildren(node)}
          <button
            type="button"
            class="chevron"
            class:open={expanded.has(node.path)}
            aria-expanded={expanded.has(node.path)}
            aria-label={expanded.has(node.path) ? i18n.t('folders.collapseFolder') : i18n.t('folders.expandFolder')}
            on:click|stopPropagation={() => toggleExpand(node.path)}
          >
            <Icon name="chevron-right" size={12} />
          </button>
        {:else}
          <span class="chevron-slot" aria-hidden="true"></span>
        {/if}
        <span class="tree-label">{node.title}</span>
        <span class="tree-count" class:visible={countVal > 0}>
          {countVal > 0 ? countVal : ''}
        </span>
        {#if !isSystemRootTitle(node.title)}
          <button
            type="button"
            class="row-action row-move"
            class:dragging={isDragging && dragNodeId === node.id}
            aria-label="{node.title} {i18n.t('folders.move')}"
            title={i18n.t('folders.move')}
            on:pointerdown={(e) => onDragStart(e, node)}
            on:pointermove={onDragMove}
            on:pointerup={onDragEnd}
            on:pointercancel={onDragCancel}
          >
            <Icon name="grip-vertical" size={14} />
          </button>
          <button
            type="button"
            class="row-action row-edit"
            aria-label="{node.title} {i18n.t('common.edit')}"
            title={i18n.t('common.edit')}
            on:click|stopPropagation={() => handleEdit(node)}
          >
            <Icon name="edit-2" size={14} />
          </button>
          <button
            type="button"
            class="row-action row-delete"
            aria-label="{node.title} {i18n.t('common.delete')}"
            title={i18n.t('common.delete')}
            on:click|stopPropagation={() => handleDelete(node.path)}
          >
            <Icon name="x" size={14} />
          </button>
        {:else}
          <button
            type="button"
            class="row-action row-clean"
            aria-label="{node.title} {i18n.t('folders.cleanEmptyFolders')}"
            title={i18n.t('folders.cleanEmptyFolders')}
            on:click|stopPropagation={() => handleClean(node.path, node.id, node.title)}
          >
            <Icon name="trash-2" size={14} />
          </button>
        {/if}
      </div>
    {/each}
    {#if dropLineTop !== null}
      <div class="drop-line" style="top: {dropLineTop}px; left: {dropLineLeft}px;" aria-hidden="true"></div>
    {/if}
  </div>
</div>

<style>
  /* Same panel style as settings page left TOC legend (settings-toc) */
  .folder-tree {
    display: flex;
    flex-direction: column;
    max-height: inherit;
    min-height: 0;
    flex: 1 1 auto;
    box-sizing: border-box;
    padding: 1rem;
    overflow-y: auto;
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-sm);
    font-family: var(--font-primary);
  }

  /* Separate header (fixed) and tree area — header stays sticky at top during scroll */
  .tree-scroll {
    position: relative; /* Base for absolute positioning of drop indicator */
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .tree-scroll.dragging {
    cursor: grabbing;
    user-select: none;
  }

  /* Target row being dragged — highlight grabbed row */
  .tree-item.dragging-target {
    opacity: 0.6;
  }

  /* Cross-folder move (move-into) drop target — highlight destination folder */
  .tree-item.drop-target {
    outline: 2px solid var(--color-primary);
    outline-offset: -2px;
    background: var(--color-primary-light);
  }

  /* Bookmark drag-and-drop drop target — highlight destination folder */
  .tree-item.bookmark-drop-target {
    outline: 2px solid var(--color-primary);
    outline-offset: -2px;
    background: var(--color-primary-light);
    border-left-color: var(--color-primary);
    color: var(--color-primary);
  }

  /* Drop position indicator — horizontal ribbon line */
  .drop-line {
    position: absolute;
    right: 8px;
    height: 2px;
    z-index: 5;
    background: var(--color-primary);
    border-radius: 1px;
    pointer-events: none;
    transition: top var(--transition-fast), left var(--transition-fast);
  }

  .drop-line::before {
    content: '';
    position: absolute;
    left: -3px;
    top: -2px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-primary);
  }

  .tree-item {
    position: relative; /* Base for absolute positioning of hover action buttons */
    display: flex;
    align-items: center;
    gap: 0.375rem;
    height: 32px;
    flex-shrink: 0; /* Prevent rows from shrinking under max-height cap — ensure internal scrolling */
    padding: 0 0.5rem;
    box-sizing: border-box;
    border-left: 3px solid transparent; /* Same left ribbon as settings page TOC items */
    border-radius: 0 var(--radius-md) var(--radius-md) 0;
    color: var(--text-secondary);
    font-size: 0.875rem;
    cursor: pointer;
    user-select: none;
    transition: background-color var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast);
  }

  .tree-item:hover {
    background-color: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .tree-item.active {
    background-color: var(--color-primary-light);
    color: var(--color-primary);
    border-left-color: var(--color-primary);
    font-weight: 600;
  }

  .root-item {
    font-weight: 600;
  }

  /* Fixed slot for chevron (12px) — keeps icon column alignment even for childless folders */
  .chevron,
  .chevron-slot {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 16px;
    width: 16px;
    height: 16px;
  }

  .chevron {
    background: none;
    border: none;
    padding: 0;
    color: var(--text-muted);
    cursor: pointer;
    border-radius: var(--radius-sm);
    transition: transform var(--transition-fast), color var(--transition-fast);
  }

  .chevron:hover {
    color: var(--text-primary);
  }

  .chevron:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: -1px;
  }

  /* No chevron-down icon — expansion is represented by rotation */
  .chevron.open {
    transform: rotate(90deg);
  }

  .tree-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Count — mono digits without border/margin. If 0 or missing, visibility:hidden preserves placeholder (prevents layout shift) */
  .tree-count {
    flex: 0 0 auto;
    min-width: 1.75rem;
    text-align: center;
    box-sizing: border-box;
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    font-weight: 600;
    line-height: 1;
    color: var(--text-muted);
    visibility: hidden;
    transition: color var(--transition-fast);
  }

  .tree-count.visible {
    visibility: visible;
  }

  .tree-item.active .tree-count {
    color: var(--color-primary);
  }

  /* --- hover action buttons (move handle / delete X) ---
     Absolutely positioned to avoid affecting row flex layout; displayed only on mouse hover.
     Defaults to opacity:0 + visibility:hidden -> revealed on .tree-item:hover */
  .row-action {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border: none;
    border-radius: var(--radius-sm);
    background: var(--bg-tertiary);
    color: var(--text-muted);
    cursor: pointer;
    opacity: 0;
    visibility: hidden;
    z-index: 1;
    transition: opacity var(--transition-fast), visibility var(--transition-fast),
      color var(--transition-fast), background-color var(--transition-fast);
  }

  .row-move {
    left: 2px;
    cursor: grab; /* Move drag handle */
  }

  .row-move:active {
    cursor: grabbing;
  }

  .row-delete,
  .row-clean {
    right: 2px;
  }

  .row-edit {
    right: 26px;
  }

  .row-action:hover {
    color: var(--text-primary);
    background: var(--border-color);
  }

  .row-edit:hover {
    color: var(--color-primary);
    background: var(--color-primary-light, var(--bg-tertiary));
  }

  /* Delete / Clean button hover — declared after general hover so danger color takes precedence */
  .row-delete:hover,
  .row-clean:hover {
    color: var(--color-danger);
    background: var(--color-danger-light, var(--bg-tertiary));
  }

  .row-action:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: -1px;
  }

  .tree-item:hover .row-action {
    opacity: 1;
    visibility: visible;
  }

  .tree-item:hover .tree-label {
    margin-right: 24px;
  }

  /* Hide count on hover — preserves placeholder so right delete button doesn't overlap count badge */
  .tree-item:hover .tree-count {
    visibility: hidden;
  }
</style>
