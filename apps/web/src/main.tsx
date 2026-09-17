import { createRoot } from 'react-dom/client';
import './theme.css';
import { App } from './app';
import { ErrorBoundary } from './components/ErrorBoundary';

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary name="NInfer Studio App">
    <App />
  </ErrorBoundary>,
);

