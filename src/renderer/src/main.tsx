import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { loadAppTheme } from './appTheme.js';
import { loadGeorgianFonts } from './terminal/themes.js';
import './styles/fonts.css';
import './styles/app.css';
import './styles/workspace.css';
import './styles/files.css';
import './styles/glass.css';

const root = document.getElementById('root');
if (root) {
  // Started before any terminal opens; terminals re-measure when it is done.
  void loadGeorgianFonts();
  void loadAppTheme();
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
