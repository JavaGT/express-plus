<script>
  import { bindField } from './workbench-ui-bindings.mjs';

  let {
    store,
    id,
    field,
    action,
    type = 'select',
    options = [],
    label = '',
    ...restProps
  } = $props();

  let bound = bindField(store, { id, field });
  let value = $state(bound.value);
  let status = $state('idle');
  let error = $state(null);

  $effect(() => {
    const unsub = bound.subscribe((s) => {
      value = s.value;
      status = s.status;
      error = s.error;
    });
    return () => {
      unsub();
      bound.destroy();
    };
  });

  function handleChange(newValue) {
    bound.update(newValue);
  }
</script>

<div
  data-wb-part="form-input"
  data-status={status}
  data-type={type}
  data-field={field}
  class="wb-form-input wb-form-input--{type}"
>
  {#if label}
    <label class="wb-form-input__label">{label}</label>
  {/if}

  {#if type === 'select'}
    <select
      class="wb-form-input__select"
      onchange={(e) => handleChange(e.target.value)}
      disabled={status === 'pending'}
      {...restProps}
    >
      {#each options as opt}
        <option value={opt.value} selected={opt.value === (value ?? '')}>{opt.label}</option>
      {/each}
    </select>
  {:else if type === 'checkbox'}
    <label class="wb-form-input__checkbox-label">
      <input
        type="checkbox"
        class="wb-form-input__checkbox"
        checked={!!value}
        onchange={() => handleChange(value ? 0 : 1)}
        disabled={status === 'pending'}
        {...restProps}
      />
      <span>{options.length > 0 ? options[0].label : ''}</span>
    </label>
  {:else if type === 'radio'}
    {#each options as opt}
      <label class="wb-form-input__radio-label">
        <input
          type="radio"
          class="wb-form-input__radio"
          name={field}
          value={opt.value}
          checked={value === opt.value}
          onchange={() => handleChange(opt.value)}
          disabled={status === 'pending'}
          {...restProps}
        />
        <span>{opt.label}</span>
      </label>
    {/each}
  {:else if type === 'enum'}
    <div class="wb-form-input__enum-group">
      {#each options as opt}
        <button
          class="wb-form-input__enum-btn"
          data-selected={value === opt.value ? 'true' : 'false'}
          onclick={() => handleChange(opt.value)}
          disabled={status === 'pending'}
          {...restProps}
        >
          {opt.label}
        </button>
      {/each}
    </div>
  {/if}
</div>
