import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';

import { App } from './App';
import { queryClient } from './services/data/queryClient';
import { startMockServer } from './services/msw/browser';
import { startOutboxDelivery } from './services/outbox/outboxStore';
import './styles/global.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Root container #root was not found in the document');
}

const root = createRoot(container);

/**
 * The mock API is started BEFORE the first React render, and the app is not
 * mounted until it is ready.
 *
 * THIS ORDERING IS LOAD-BEARING. The service worker only intercepts requests once
 * it is registered and controlling the page. If the app renders first, the very
 * first ranking query escapes interception, reaches the dev server or the static
 * host, and receives the SPA fallback — `index.html` with status 200.
 *
 * That response is the worst kind of failure: a 200 is a success, so the query
 * cache stores the HTML as if it were a ranking payload, and the table renders
 * permanently empty with no error anywhere. Awaiting the worker removes the race
 * entirely.
 */
void startMockServer()
  .then(() => {
    startOutboxDelivery();

    root.render(
      // StrictMode is intentional: it double-invokes effects in development,
      // which is the pressure test the canvas and asset lifecycles must survive.
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </StrictMode>,
    );
  })
  .catch((error: unknown) => {
    // Never fatal: the game does not depend on the mock API, only the records
    // panels do. Mount anyway so the player can still play.
    console.warn('[bootstrap] mock server unavailable, mounting anyway', error);

    root.render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </StrictMode>,
    );
  });
