<script>
  import '../app.css';
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { experiments } from '$lib/experiments/registry.js';
  import { theme } from '$lib/theme.svelte.js';

  let { children } = $props();

  let currentId = $derived($page.params.experiment);

  // Mobile drawer state. On desktop the sidebar is always visible and
  // `sidebarOpen` is simply ignored by the CSS (no transform on wide screens).
  let sidebarOpen = $state(false);

  onMount(() => theme.init());

  $effect(() => {
    document.documentElement.dataset.theme = theme.resolved;
  });

  // Close the drawer whenever the route changes — otherwise tapping a link
  // on mobile would leave it hanging open over the new experiment.
  $effect(() => {
    currentId;
    sidebarOpen = false;
  });
</script>

<div class="app" class:drawer-open={sidebarOpen}>
  <!-- Mobile-only hamburger. Floats above the map/page content. -->
  <button
    class="menu-btn"
    onclick={() => (sidebarOpen = !sidebarOpen)}
    aria-label="Abrir menú"
    aria-expanded={sidebarOpen}
  >
    {#if sidebarOpen}
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="18" y1="6" x2="6" y2="18"/>
        <line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    {:else}
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="3" y1="6" x2="21" y2="6"/>
        <line x1="3" y1="12" x2="21" y2="12"/>
        <line x1="3" y1="18" x2="21" y2="18"/>
      </svg>
    {/if}
  </button>

  <!-- Backdrop for the drawer on mobile. -->
  {#if sidebarOpen}
    <div
      class="backdrop"
      onclick={() => (sidebarOpen = false)}
      onkeydown={(e) => e.key === 'Escape' && (sidebarOpen = false)}
      role="button"
      tabindex="-1"
      aria-label="Cerrar menú"
    ></div>
  {/if}

  <aside class="sidebar">
    <div class="brand-row">
      <a href="/" class="brand">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/>
          <circle cx="12" cy="9" r="2.5"/>
        </svg>
        <div>
          <span class="brand-name">Maps Sandbox</span>
          <span class="brand-sub">Google Maps experiments</span>
        </div>
      </a>

      <button
        class="theme-btn"
        onclick={() => theme.toggle()}
        title={theme.mode === 'system'
          ? 'Sistema (click → oscuro)'
          : theme.mode === 'dark'
          ? 'Oscuro (click → claro)'
          : 'Claro (click → sistema)'}
        aria-label="Cambiar tema"
      >
        {#if theme.resolved === 'dark'}
          <!-- Sun -->
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="5"/>
            <line x1="12" y1="1" x2="12" y2="3"/>
            <line x1="12" y1="21" x2="12" y2="23"/>
            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
            <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
            <line x1="1" y1="12" x2="3" y2="12"/>
            <line x1="21" y1="12" x2="23" y2="12"/>
            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
            <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
          </svg>
        {:else}
          <!-- Moon -->
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
          </svg>
        {/if}
        {#if theme.mode === 'system'}
          <span class="theme-badge">auto</span>
        {/if}
      </button>
    </div>

    <p class="section-label">Experiments</p>

    <nav>
      {#each experiments as exp (exp.id)}
        <a
          href="/{exp.id}"
          class="exp-link"
          class:active={currentId === exp.id}
        >
          <span class="exp-name">{exp.name}</span>
          <span class="exp-desc">{exp.description}</span>
        </a>
      {/each}
    </nav>
  </aside>

  <main>
    {@render children()}
  </main>
</div>

<style>
  .app {
    display: flex;
    height: 100vh;
    height: 100dvh;
    overflow: hidden;
  }

  .sidebar {
    width: 260px;
    flex-shrink: 0;
    background: var(--surface);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    transition: background 0.2s, border-color 0.2s;
  }

  .brand-row {
    display: flex;
    align-items: center;
    border-bottom: 1px solid var(--border);
    transition: border-color 0.2s;
  }

  .brand {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 1.125rem 0.75rem 1.125rem 1rem;
    text-decoration: none;
    color: inherit;
    min-width: 0;
  }
  .brand svg {
    width: 26px;
    height: 26px;
    flex-shrink: 0;
    color: var(--accent);
  }
  .brand-name {
    display: block;
    font-weight: 600;
    font-size: 0.9375rem;
    color: var(--text);
  }
  .brand-sub {
    display: block;
    font-size: 0.75rem;
    color: var(--text-4);
    margin-top: 1px;
  }

  .theme-btn {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 0.625rem 0.75rem;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-3);
    border-radius: 0.5rem;
    margin-right: 0.375rem;
    transition: background 0.15s, color 0.15s;
  }
  .theme-btn:hover {
    background: var(--hover);
    color: var(--text);
  }
  .theme-btn svg {
    width: 18px;
    height: 18px;
  }
  .theme-badge {
    font-size: 0.5625rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--accent-text);
    background: var(--accent-bg);
    padding: 1px 4px;
    border-radius: 3px;
  }

  .section-label {
    margin: 0;
    padding: 1rem 1rem 0.375rem;
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-4);
  }

  nav {
    display: flex;
    flex-direction: column;
    padding: 0.25rem 0.5rem 0.5rem;
    gap: 2px;
  }

  .exp-link {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 0.625rem;
    border-radius: 0.5rem;
    text-decoration: none;
    color: inherit;
    transition: background 0.1s;
  }
  .exp-link:hover { background: var(--hover); }
  .exp-link.active { background: var(--accent-bg); }
  .exp-link.active .exp-name { color: var(--accent-text); }

  .exp-name {
    font-weight: 500;
    font-size: 0.875rem;
    color: var(--text-2);
  }
  .exp-desc {
    font-size: 0.75rem;
    color: var(--text-4);
    line-height: 1.4;
  }

  main {
    flex: 1;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    transition: background 0.2s;
  }

  /* Mobile-only UI: hidden on desktop. */
  .menu-btn { display: none; }
  .backdrop { display: none; }

  /* ── Mobile ─────────────────────────────────────────────────────────────── */
  @media (max-width: 768px) {
    .sidebar {
      position: fixed;
      inset: 0 auto 0 0;
      width: min(82vw, 300px);
      z-index: 40;
      transform: translateX(-100%);
      transition: transform 0.25s ease, background 0.2s, border-color 0.2s;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18);
    }
    .app.drawer-open .sidebar {
      transform: translateX(0);
    }

    .backdrop {
      display: block;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.35);
      z-index: 30;
      animation: fade-in 0.2s ease;
    }
    @keyframes fade-in {
      from { opacity: 0; }
      to   { opacity: 1; }
    }

    .menu-btn {
      display: flex;
      position: fixed;
      top: 12px;
      left: 12px;
      z-index: 50;
      width: 40px;
      height: 40px;
      align-items: center;
      justify-content: center;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 0.625rem;
      color: var(--text-2);
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
      transition: background 0.15s;
    }
    .menu-btn:hover { background: var(--hover); }
    .menu-btn svg { width: 20px; height: 20px; }

    main {
      width: 100%;
    }
  }
</style>
