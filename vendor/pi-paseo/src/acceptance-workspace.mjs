import { RuntimeError } from './state.mjs';

// An archive receipt can report success after partial server-side cleanup.
// Confirm absence from the active directory, following every page in this project.
async function confirmArchived(client, workspace) {
  let cursor;
  const seen = new Set();
  for (let page = 0; page < 20; page++) {
    const result = await client.fetchWorkspaces({
      filter: { projectId: workspace.projectId }, page: { limit: 200, ...(cursor ? { cursor } : {}) },
    });
    if (!Array.isArray(result?.entries) || result.entries.some(entry => entry.id === workspace.id)) return false;
    if (result.pageInfo?.hasMore === false) return true;
    cursor = result.pageInfo?.nextCursor;
    if (typeof cursor !== 'string' || !cursor || seen.has(cursor)) return false;
    seen.add(cursor);
  }
  return false;
}

/** Only archive the workspace returned by this fresh directory creation. */
export async function usingAcceptanceWorkspace(client, cwd, row, verify) {
  const created = await client.createWorkspace({ source: { kind: 'directory', path: cwd } });
  const workspace = created?.workspace;
  if (!workspace?.id || created.error) throw new RuntimeError('WORKSPACE_CREATE_FAILED');
  row.workspaceId = workspace.id;
  // Never allow the worktree archive path, which may remove a backing directory.
  const canArchive = ['directory', 'local_checkout', 'checkout'].includes(workspace.workspaceKind)
    && !workspace.worktreeSlug && typeof workspace.projectId === 'string' && workspace.projectId.length > 0;
  try {
    if (!canArchive) throw new RuntimeError('WORKSPACE_CREATE_FAILED');
    return await verify(workspace);
  } finally {
    let archived = false;
    try {
      if (canArchive) {
        const receipt = await client.archiveWorkspace(workspace.id);
        archived = receipt?.workspaceId === workspace.id && !receipt.error
          && typeof receipt.archivedAt === 'string' && Number.isFinite(Date.parse(receipt.archivedAt))
          && await confirmArchived(client, workspace);
      }
    } catch { /* Only fixed cleanup codes leave this boundary. */ }
    row.workspaceCleanup = archived ? { archived: true } : { archived: false, code: 'ACCEPTANCE_CLEANUP_FAILED' };
    if (!archived || row.cleanup?.archived === false) {
      row.cleanup = { archived: false, code: 'ACCEPTANCE_CLEANUP_FAILED' };
      row.passed = false;
      row.code ||= 'ACCEPTANCE_CLEANUP_FAILED';
    }
  }
}
