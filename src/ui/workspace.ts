import { useCallback, useEffect, useState } from 'react';
import { getDb } from '@/core/db/db';
import {
  getWorkspaceBundle,
  type WorkspaceBundle,
} from '@/core/db/workspace-service';
import type { Workspace } from '@/core/model';

const ACTIVE_WORKSPACE_KEY = 'activeWorkspaceId';

export async function listWorkspaces(): Promise<Workspace[]> {
  const workspaces = await getDb().workspaces.toArray();
  return workspaces.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getActiveWorkspaceId(): Promise<string | undefined> {
  const stored = await chrome.storage.local.get(ACTIVE_WORKSPACE_KEY);
  const value = stored[ACTIVE_WORKSPACE_KEY];
  return typeof value === 'string' ? value : undefined;
}

export async function setActiveWorkspaceId(workspaceId: string): Promise<void> {
  await chrome.storage.local.set({ [ACTIVE_WORKSPACE_KEY]: workspaceId });
}

export async function resolveWorkspace(
  preferredId?: string,
): Promise<WorkspaceBundle | undefined> {
  const db = getDb();
  const storedId = preferredId ?? (await getActiveWorkspaceId());
  if (storedId) {
    const bundle = await getWorkspaceBundle(db, storedId);
    if (bundle) return bundle;
  }
  const first = (await listWorkspaces())[0];
  if (!first) return undefined;
  await setActiveWorkspaceId(first.id);
  return getWorkspaceBundle(db, first.id);
}

export interface WorkspaceState {
  bundle: WorkspaceBundle | undefined;
  workspaces: Workspace[];
  loading: boolean;
  error: string | undefined;
  reload: () => Promise<void>;
  selectWorkspace: (workspaceId: string) => Promise<void>;
}

export function useWorkspace(): WorkspaceState {
  const [bundle, setBundle] = useState<WorkspaceBundle>();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const reload = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [nextWorkspaces, nextBundle] = await Promise.all([
        listWorkspaces(),
        resolveWorkspace(),
      ]);
      setWorkspaces(nextWorkspaces);
      setBundle(nextBundle);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  const selectWorkspace = useCallback(
    async (workspaceId: string) => {
      await setActiveWorkspaceId(workspaceId);
      await reload();
    },
    [reload],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  return { bundle, workspaces, loading, error, reload, selectWorkspace };
}
