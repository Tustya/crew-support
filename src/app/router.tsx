import { Navigate, createBrowserRouter } from 'react-router-dom'
import { CorrectionsPage } from '../features/corrections/CorrectionsPage'
import { HistoryPage } from '../features/history/HistoryPage'
import { MailPage } from '../features/mail/MailPage'
import { OverviewPage } from '../features/overview/OverviewPage'
import { SettingsPage } from '../features/settings/SettingsPage'
import { Shell } from '../ui/Shell'

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
