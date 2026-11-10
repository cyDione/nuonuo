import { AnimateUIProvider } from '@animate-ui/react/provider'
import { MotionConfig } from 'motion/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { applyPrefs, usePrefs } from './prefs'
import './index.css'

applyPrefs()
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: (count, error: any) => error?.status !== 401 && count < 2, refetchOnWindowFocus: false } } })

/** 减少动态效果 in 设置 → 通用 turns motion off here too, on top of the system setting. */
function Motion({ children }: { children: ReactNode }) {
  const reduce = usePrefs().reduceMotion ? 'always' : 'user'
  return <AnimateUIProvider reducedMotion={reduce}><MotionConfig reducedMotion={reduce}>{children}</MotionConfig></AnimateUIProvider>
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Motion>
      <QueryClientProvider client={queryClient}><App /></QueryClientProvider>
    </Motion>
  </StrictMode>,
)
