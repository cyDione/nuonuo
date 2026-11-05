import { useQuery } from '@tanstack/react-query'
import { api, type Catalog, type Provider } from '../api'

export const useCatalog = () => useQuery({ queryKey: ['catalog'], queryFn: () => api.get<Catalog>('/catalog'), staleTime: Infinity })
export const useProviders = () => useQuery({ queryKey: ['providers'], queryFn: () => api.get<{ providers: Provider[] }>('/providers') })

/**
 * The model ids to offer for a provider (live list plus suggestions, merged by the service). With `role`, they are the ones
 * that layer can use, decision models (Jev) first on the reviewer. A failed list is not kept: the next mount or `refresh()`
 * asks the provider again.
 */
export function useModelOptions(provider: Provider | undefined, role?: string) {
  const live = useQuery({
    queryKey: ['models', provider?.id, role ?? null], enabled: Boolean(provider), retry: false,
    staleTime: q => (q.state.data?.error ? 0 : 10 * 60_000),
    queryFn: () => api.get<{ models: string[]; error?: string }>(`/providers/${provider!.id}/models${role ? `?role=${encodeURIComponent(role)}` : ''}`),
  })
  return {
    models: live.data?.models ?? [],
    error: live.data?.error ?? (live.error ? (live.error as Error).message : undefined),
    loading: live.isFetching,
    refresh: () => { void live.refetch() },
  }
}
