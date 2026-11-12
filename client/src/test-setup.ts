import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

declare global {
  interface Window {
    React: typeof React;
  }
}

window.React = React;
// @ts-expect-error The reference bundle is a global UMD script with no module exports.
await import('../../docs/design-system/components/bundle.js');

afterEach(cleanup);
