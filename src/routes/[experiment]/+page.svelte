<script>
  import { experiments } from '$lib/experiments/registry.js';

  let { data } = $props();

  let Component = $state(null);

  $effect(() => {
    Component = null;
    const exp = experiments.find((e) => e.id === data.experimentId);
    if (exp) {
      exp.component().then((mod) => {
        Component = mod.default;
      });
    }
  });
</script>

{#if Component}
  <Component />
{:else}
  <div class="loading">
    <span class="spinner"></span>
  </div>
{/if}

<style>
  .loading {
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .spinner {
    width: 28px;
    height: 28px;
    border: 3px solid #e5e7eb;
    border-top-color: #4f46e5;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
