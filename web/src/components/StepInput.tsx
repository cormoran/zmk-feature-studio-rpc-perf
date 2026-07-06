export function StepInput({
  id,
  value,
  min,
  max,
  smallStep,
  largeStep,
  presets,
  disabled,
  onChange,
}: {
  id: string;
  value: number;
  min: number;
  max: number;
  smallStep: number;
  largeStep: number;
  presets: number[];
  disabled: boolean;
  onChange: (v: number) => void;
}) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const adj = (delta: number) => () => onChange(clamp(value + delta));

  return (
    <div className="step-input">
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(clamp(parseInt(e.target.value, 10)))}
        className="step-slider"
      />
      <div className="step-row">
        <button
          type="button"
          className="step-btn"
          onClick={adj(-largeStep)}
          disabled={disabled}
        >
          −{largeStep}
        </button>
        <button
          type="button"
          className="step-btn"
          onClick={adj(-smallStep)}
          disabled={disabled}
        >
          −{smallStep}
        </button>
        <input
          id={id}
          type="number"
          min={min}
          max={max}
          value={value}
          disabled={disabled}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10);
            if (!isNaN(v)) onChange(clamp(v));
          }}
          className="step-number-input"
        />
        <button
          type="button"
          className="step-btn"
          onClick={adj(smallStep)}
          disabled={disabled}
        >
          +{smallStep}
        </button>
        <button
          type="button"
          className="step-btn"
          onClick={adj(largeStep)}
          disabled={disabled}
        >
          +{largeStep}
        </button>
      </div>
      <div className="step-presets">
        {presets.map((p) => (
          <button
            key={p}
            type="button"
            className={`preset-btn${value === p ? " preset-active" : ""}`}
            disabled={disabled || p > max}
            onClick={() => onChange(clamp(p))}
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}
