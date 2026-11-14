import { lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import Planner from './planner/Planner'
import './style.css'

const Legacy = lazy(() => import('./legacy'))
const legacy = new URLSearchParams(location.search).has('legacy')
createRoot(document.getElementById('root')!).render(
  legacy ? <Suspense fallback={<p>Loading experimental workstation…</p>}><Legacy /></Suspense> : <Planner />,
)
