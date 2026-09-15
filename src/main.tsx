import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import App from './App';
import { applyBrand } from './brand';
import './styles.css';

/* Before the first render, so the first button painted is already in the
   customer's colour and the tab already carries their name. See brand.ts. */
applyBrand();

/**
 * One catch-all route, and App reads the path itself.
 *
 * Four separate <Route> entries all rendering <App/> would work until React
 * decided to remount on a path change, taking the open conversation with it.
 * A single route keeps App mounted for the life of the session and lets it
 * derive what to show from the URL.
 */
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/*" element={<App />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
