import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { AuthGate } from './components/AuthGate';
import './styles.css';
import './workspace-design-system.css';

declare global {
  interface Window {
    React: typeof React;
  }
}

async function startApp() {
  window.React = React;
  // @ts-expect-error The reference bundle is a global UMD script with no module exports.
  await import('../../docs/design-system/components/bundle.js');
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <BrowserRouter>
        <AuthGate>
          <App />
        </AuthGate>
      </BrowserRouter>
    </React.StrictMode>,
  );
}

void startApp();
