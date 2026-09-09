<script>
  import { onMount, untrack } from 'svelte';

  let {
    initialValue = '',
    ariaLabel = 'Name',
    className = '',
    onconfirm = () => {},
    oncancel = () => {},
    onvaluechange = () => {}
  } = $props();

  let inputElement;
  let value = $state(untrack(() => String(initialValue ?? '')));
  let finished = false;

  onMount(() => {
    inputElement?.focus();
    inputElement?.select();
    inputElement?.scrollIntoView({ block: 'nearest' });
  });

  function confirm(reason = 'blur') {
    if (finished) return;
    finished = true;
    onconfirm(value, reason);
  }

  function cancel(reason = 'escape') {
    if (finished) return;
    finished = true;
    oncancel(reason);
  }

  function handleKeydown(event) {
    if (event.key !== 'Tab') event.stopPropagation();
    if (event.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      confirm('enter');
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancel('escape');
    }
  }

  function handleInput(event) {
    value = event.currentTarget.value;
    onvaluechange(value);
  }
</script>

<input
  bind:this={inputElement}
  {value}
  class={className}
  type="text"
  aria-label={ariaLabel}
  autocomplete="off"
  spellcheck="false"
  onclick={(event) => event.stopPropagation()}
  onpointerdown={(event) => event.stopPropagation()}
  oncontextmenu={(event) => event.stopPropagation()}
  oninput={handleInput}
  onkeydown={handleKeydown}
  onblur={() => confirm('blur')}
/>
