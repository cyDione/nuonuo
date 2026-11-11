import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Catalog, type NotifySettings, type Provider } from '../api'
import { desktop, type DesktopPrefs } from '../shell'
import { tx } from '../i18n'

export const useCatalog = () => useQuery({ queryKey: ['catalog'], queryFn: () => api.get<Catalog>('/catalog'), staleTime: Infinity })
export const useProviders = () => useQuery({ queryKey: ['providers'], queryFn: () => api.get<{ providers: Provider[] }>('/providers') })

export type ModelType = 'chat' | 'embedding' | 'rerank' | 'decision' | 'image' | 'audio' | 'video'

/** The tag a model list shows beside a model that is not a chat model. */
export const modelTag = (type: ModelType | undefined): string | undefined => type === undefined || type === 'chat' ? undefined
  : ({ embedding: tx('向量'), rerank: tx('重排'), decision: tx('决策模型'), image: tx('图像'), audio: tx('语音'), video: tx('视频') } as const)[type]

/**
 * The models to offer for a provider (every model it serves, chat, embedding, rerank and Jev alike, plus suggestions, merged
 * by the service), with each one's type. With `role`, the ones that layer runs come first: embedding models on the embedding
 * layer, decision models (Jev) on the reviewer, and decision models are left out where they cannot be used. A failed list is not kept: the next mount or `refresh()`
 * asks the provider again.
 */
export function useModelOptions(provider: Provider | undefined, role?: string) {
  const live = useQuery({
    queryKey: ['models', provider?.id, role ?? null], enabled: Boolean(provider), retry: false,
    staleTime: q => (q.state.data?.error ? 0 : 10 * 60_000),
    queryFn: () => api.get<{ models: string[]; types?: Record<string, ModelType>; error?: string }>(`/providers/${provider!.id}/models${role ? `?role=${encodeURIComponent(role)}` : ''}`),
  })
  return {
    models: live.data?.models ?? [],
    types: live.data?.types ?? {},
    error: live.data?.error ?? (live.error ? (live.error as Error).message : undefined),
    loading: live.isFetching,
    refresh: () => { void live.refetch() },
  }
}

/** 通知 settings (also holds the quiet hours shown on 助理); saved a field at a time, shown at once. */
export function useNotify() {
  const qc = useQueryClient()
  const query = useQuery({ queryKey: ['notify'], queryFn: () => api.get<{ settings: NotifySettings; defaults: NotifySettings }>('/settings/notifications') })
  const save = useMutation({
    mutationFn: (patch: Partial<NotifySettings>) => api.put<{ settings: NotifySettings }>('/settings/notifications', patch),
    onMutate: patch => qc.setQueryData<{ settings: NotifySettings }>(['notify'], old => old && { ...old, settings: { ...old.settings, ...patch } }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['notify'] }),
  })
  return { data: query.data, save: save.mutate, error: save.error }
}

/** The desktop app's own settings (start at login, menu-bar icon, closing the window, global shortcuts); null in a browser. */
export function useDesktopPrefs() {
  const qc = useQueryClient()
  const bridge = desktop?.prefs
  const query = useQuery({ queryKey: ['desktop-prefs'], queryFn: () => bridge!.get(), enabled: Boolean(bridge), staleTime: Infinity })
  const save = useMutation({
    mutationFn: (patch: Partial<Omit<DesktopPrefs, 'registered'>>) => bridge!.set(patch),
    onMutate: patch => qc.setQueryData<DesktopPrefs>(['desktop-prefs'], old => old && { ...old, ...patch }),
    onSuccess: data => qc.setQueryData(['desktop-prefs'], data),
  })
  return bridge ? { prefs: query.data, save: save.mutate } : null
}
