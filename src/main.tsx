import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import '@fontsource-variable/bricolage-grotesque/opsz.css'
import '@fontsource/instrument-sans/400.css'
import '@fontsource/instrument-sans/500.css'
import '@fontsource/instrument-sans/600.css'
import '@fontsource/instrument-sans/700.css'
// Barron brand fonts, used only when data-brand is set (the browser fetches a face only once it is used).
import '@fontsource-variable/quicksand/wght.css'
import '@fontsource-variable/raleway/wght.css'
import './styles.css'
import { ADMIN_MODE } from './quality/flags'

if (ADMIN_MODE) {
  document.title = 'Barron Vectoriser · Layout team'
  document.documentElement.dataset.brand = 'barron'
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
