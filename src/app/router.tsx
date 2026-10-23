import { lazy } from 'react'
import { Navigate, createBrowserRouter } from 'react-router-dom'
import { Shell } from '../ui/Shell'

const OverviewPage = lazy(() => import('../features/overview/OverviewPage').then((module) => ({ default: module.OverviewPage })))
const CorrectionsPage = lazy(() => import('../features/corrections/CorrectionsPage').then((module) => ({ default: module.CorrectionsPage })))
const MailPage = lazy(() => import('../features/mail/MailPage').then((module) => ({ default: module.MailPage })))
const HistoryPage = lazy(() => import('../features/history/HistoryPage').then((module) => ({ default: module.HistoryPage })))
const SettingsPage = lazy(() => import('../features/settings/SettingsPage').then((module) => ({ default: module.SettingsPage })))

export const router = createBrowserRouter([
  {
    path: '/',
    element: <Shell />,
    children: [
      { index: true, element: <Navigate to="/overview" replace /> },
      { path: 'overview', element: <OverviewPage /> },
      { path: 'corrections', element: <CorrectionsPage /> },
      { path: 'mail', element: <MailPage /> },
      { path: 'history', element: <HistoryPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
])
