import './style.css';
import { Header } from './components/Header.js';
import { ImageStudio } from './components/ImageStudio.js';
import { BackendModal } from './components/BackendModal.js';
import { engine } from './lib/engine.js';

const app = document.querySelector('#app');
let contentArea;
let booted = false;

// Router
function navigate(page) {
  if (!contentArea) return;
  contentArea.innerHTML = '';

  if (page === 'image') {
    contentArea.appendChild(ImageStudio());
  } else if (page === 'video') {
    import('./components/VideoStudio.js').then(({ VideoStudio }) => {
      contentArea.appendChild(VideoStudio());
    });
  } else if (page === 'library') {
    import('./components/LibraryPage.js').then(({ LibraryPage }) => {
      contentArea.appendChild(LibraryPage());
    });
  } else if (page === 'cinema') {
    import('./components/CinemaStudio.js').then(({ CinemaStudio }) => {
      contentArea.appendChild(CinemaStudio());
    });
  } else if (page === 'longform') {
    import('./components/LongFormStudio.js').then(({ LongFormStudio }) => {
      contentArea.appendChild(LongFormStudio());
    });
  } else if (page === 'tools') {
    import('./components/ToolsPage.js').then(({ ToolsPage }) => {
      contentArea.appendChild(ToolsPage());
    });
  } else if (page === 'lipsync') {
    import('./components/LipSyncStudio.js').then(({ LipSyncStudio }) => {
      contentArea.appendChild(LipSyncStudio());
    });
  }
}

// Event Listener for Navigation
window.addEventListener('navigate', (e) => {
  navigate(e.detail.page);
});

// --- Sign-in gate -------------------------------------------------------
// Nothing in the app renders until the visitor is signed in with their
// content-factory account (first name + PIN). The session cookie is
// httpOnly, so the only way to know is to ask the backend's /session
// endpoint, which answers 401 when there is no valid session.
async function hasValidSession() {
  try {
    const res = await fetch('/.netlify/functions/session', { credentials: 'include' });
    if (!res.ok) return false;
    const data = await res.json().catch(() => null);
    return Boolean(data && data.ok);
  } catch {
    return false;
  }
}

function showCheckingScreen() {
  app.innerHTML = '';
  const screen = document.createElement('div');
  screen.className = 'flex-1 flex items-center justify-center';
  screen.innerHTML = '<p class="text-muted text-xs font-bold uppercase tracking-widest animate-pulse">Loading…</p>';
  app.appendChild(screen);
}

function showSignInGate() {
  app.innerHTML = '';
  const screen = document.createElement('div');
  screen.className = 'flex-1 flex flex-col items-center justify-center gap-4 px-6 text-center';
  screen.innerHTML = `
    <h1 class="text-3xl md:text-5xl font-black text-white tracking-widest uppercase">MATAI</h1>
    <p class="text-secondary text-sm font-medium tracking-wide opacity-60">AI Image &amp; Video Studio — sign in to continue.</p>
  `;
  app.appendChild(screen);

  // BackendModal renders the name + PIN sign-in form and calls back on
  // success. Remove its Cancel button: behind the gate there is nothing
  // to cancel back to.
  const modal = BackendModal(() => bootApp());
  modal.querySelector('#cf-cancel-btn')?.remove();
}

function bootApp() {
  if (booted) return;
  booted = true;

  app.innerHTML = '';
  // Pass navigate to Header so links work
  app.appendChild(Header(navigate));

  contentArea = document.createElement('main');
  contentArea.id = 'content-area';
  contentArea.className = 'flex-1 relative w-full overflow-hidden flex flex-col bg-app-bg';
  app.appendChild(contentArea);

  // Initial Route
  navigate('library');
}

// Boot sequence: check the session first, render the app only when
// signed in, otherwise show nothing but the sign-in screen.
// Local engine first: when engine/server.js is running, the app works with your own
// provider keys / subscriptions and needs no content-factory account.
showCheckingScreen();
function showEngineLogin() {
  app.innerHTML = '';
  if (engine.health?.mode === 'oidc') {
    const err = new URLSearchParams(location.search).get('auth_error');
    const screen = document.createElement('div');
    screen.className = 'flex-1 flex flex-col items-center justify-center gap-5 px-6 text-center';
    screen.innerHTML = `
      <h1 class="text-3xl md:text-5xl font-black text-white tracking-widest uppercase">Studio</h1>
      <p class="text-secondary text-sm opacity-70 max-w-sm">Sign in with your passkey.</p>
      <a href="/engine/auth/login?next=${encodeURIComponent(location.pathname)}" class="rounded-xl bg-primary text-white font-black uppercase tracking-widest text-xs py-3 px-8">Sign in with ${engine.health.provider || 'Pocket ID'}</a>
      ${err ? `<p class="text-xs max-w-sm" style="color:#ff6b6b">${err.replace(/[<>&]/g, '')}</p>` : ''}`;
    app.appendChild(screen);
    return;
  }
  const screen = document.createElement('div');
  screen.className = 'flex-1 flex flex-col items-center justify-center gap-5 px-6 text-center';
  screen.innerHTML = `
    <h1 class="text-3xl md:text-5xl font-black text-white tracking-widest uppercase">Studio</h1>
    <p class="text-secondary text-sm opacity-70 max-w-sm">Enter the access code shown when your studio server started.</p>
    <form class="flex flex-col gap-3 w-full max-w-xs">
      <input name="code" type="password" autocomplete="current-password" autocapitalize="off" spellcheck="false" placeholder="Access code"
        class="w-full rounded-xl bg-white/5 border border-white/10 px-4 py-3 text-white outline-none focus:border-primary" />
      <button class="rounded-xl bg-primary text-white font-black uppercase tracking-widest text-xs py-3">Sign in</button>
      <p data-err class="text-xs" style="color:#ff6b6b;min-height:1em"></p>
    </form>`;
  app.appendChild(screen);
  const form = screen.querySelector('form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await engine.login(form.code.value.trim());
      location.reload();
    } catch (err) {
      form.querySelector('[data-err]').textContent = err.message;
    }
  };
  form.code.focus();
}

engine.detect().then(async (local) => {
  if (local && engine.needsLogin) return showEngineLogin();
  if (local) {
    await engine.registerModels().catch((e) => console.warn('[engine] catalog', e));
    window.addEventListener('engine:catalog-changed', () => engine.registerModels().catch(() => {}));
    return bootApp();
  }
  const ok = await hasValidSession();
  if (ok) bootApp();
  else showSignInGate();
});
