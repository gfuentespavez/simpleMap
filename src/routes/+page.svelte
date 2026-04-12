<script>
  import { experiments } from '$lib/experiments/registry.js';
</script>

<div class="home">
  <div class="hero">
    <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
      <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/>
      <circle cx="12" cy="9" r="2.5"/>
    </svg>
    <h1>Maps Sandbox</h1>
    <p>Elige un experimento en el panel para explorar funciones de Google Maps.</p>
  </div>

  <div class="grid">
    {#each experiments as exp (exp.id)}
      <a href="/{exp.id}" class="card">
        <span class="card-name">{exp.name}</span>
        <span class="card-desc">{exp.description}</span>
      </a>
    {/each}

    <div class="card card-add">
      <span class="card-name">+ Nuevo experimento</span>
      <span class="card-desc">Agrega un archivo en <code>src/lib/experiments/</code> y regístralo en <code>registry.js</code>.</span>
    </div>
  </div>
</div>

<style>
  .home {
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 2rem;
    gap: 2.5rem;
  }

  .hero { text-align: center; }
  .icon { width: 48px; height: 48px; color: var(--accent); margin-bottom: 0.75rem; }
  h1 { margin: 0 0 0.5rem; font-size: 1.75rem; font-weight: 700; color: var(--text); }
  p  { margin: 0; color: var(--text-3); }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 0.75rem;
    width: 100%;
    max-width: 800px;
  }

  .card {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding: 1rem 1.125rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 0.75rem;
    text-decoration: none;
    color: inherit;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .card:hover {
    border-color: var(--accent-border);
    box-shadow: 0 0 0 3px var(--accent-bg);
  }
  .card-add {
    border-style: dashed;
    cursor: default;
  }
  .card-add:hover {
    border-color: var(--border);
    box-shadow: none;
  }
  .card-name { font-weight: 600; font-size: 0.9375rem; color: var(--text-2); }
  .card-desc { font-size: 0.8125rem; color: var(--text-4); line-height: 1.5; }

  code {
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 0.75rem;
    background: var(--hover);
    padding: 0.125rem 0.3rem;
    border-radius: 0.25rem;
    color: var(--text-3);
  }
</style>
