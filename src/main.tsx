import { createRoot } from 'react-dom/client'
import '@fontsource-variable/outfit'
import '@fontsource/geist-mono/400.css'
import '@fontsource/geist-mono/500.css'
import './index.css'
import App from './App.tsx'
// Gnosis's own look, after everything inherited from AYRA so it wins (gnosis.css).
import './gnosis.css'

// Deliberately no StrictMode: its double-invoked effects would open the
// microphone and arm the wake-word engine twice, and the second subscription
// steals the audio stream from the first.
createRoot(document.getElementById('root')!).render(<App />)
