import { useQuery } from '@tanstack/react-query'
import { api, type Catalog, type Provider } from '../api'

export const useCatalog = () => useQuery({ queryKey: ['catalog'], queryFn: () => api.get<Catalog>('/catalog'), staleTime: Infinity })
export const useProviders = () => useQuery({ queryKey: ['providers'], queryFn: () => api.get<{ providers: Provider[] }>('/providers') })

/** Live model ids of a provider, merged with its preset's suggestions. */
export function useModelOptions(provider: Provider | undefined) {
  const catalog = useCatalog()
  const live = useQuery({
    queryKey: ['models', provider?.id], enabled: Boolean(provider), staleTime: 10 * 60_000,
    queryFn: () => api.get<{ models: string[]; error?: string }>(`/providers/${provider!.id}/models`),
  })
  const preset = catalog.data?.presets.find(p => p.kind === provider?.kind && (p.baseUrl ?? null) === (provider?.baseUrl ?? null))
    ?? catalog.data?.presets.find(p => p.kind === provider?.kind && p.kind !== 'openai-compatible')
  const suggested = preset?.suggestedModels ?? []
  return { models: [...new Set([...suggested, ...(live.data?.models ?? [])])], error: live.data?.error, loading: live.isFetching }
}
