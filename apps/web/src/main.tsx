import { AnimateUIProvider } from '@animate-ui/react/provider'
import { MotionConfig } from 'motion/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { applyPrefs } from './prefs'
import './index.css'

applyPrefs()
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: (count, error: any) => error?.status !== 401 && count < 2, refetchOnWindowFocus: false } } })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AnimateUIProvider reducedMotion="user">
      <MotionConfig reducedMotion="user">
        <QueryClientProvider client={queryClient}><App /></QueryClientProvider>
      </MotionConfig>
    </AnimateUIProvider>
  </StrictMode>,
)
