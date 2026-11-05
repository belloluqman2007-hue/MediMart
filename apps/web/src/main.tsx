import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './fonts.css';
import './styles.css';
import { App, StartupFailure } from './App';
import { initializeRuntime } from './platform/runtime';
const root = createRoot(document.getElementById('root')!);
void initializeRuntime()
  .then((runtime) => {
    root.render(
      <StrictMode>
        <App runtime={runtime} />
      </StrictMode>,
    );
    // Native assets are already bundled. Only cache the browser's PUBLIC shell, never API data.
    if (
      import.meta.env.PROD &&
      !runtime.native &&
      'serviceWorker' in navigator &&
      window.isSecureContext
    )
      void navigator.serviceWorker.register('./sw.js').catch(() => {
        /* Offline browser shell is optional; native startup does not depend on it. */
      });
  })
  .catch(() => root.render(<StartupFailure storage />));
