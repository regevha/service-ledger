import { stepOf, type Phase } from './phases';

export function StepBar({ phase }: { phase: Phase }) {
  const stepIndex = stepOf(phase);
  const failed = phase.name === 'error' ? phase.step : -1;
  const steps = ['Upload', 'Classify', 'Review & finalize'];
  return (
    <div className="steps" data-testid="intake-steps">
      {steps.map((label, i) => (
        <div
          key={label}
          data-testid="intake-step"
          className={`step ${i === stepIndex ? 'active' : ''} ${i < stepIndex ? 'done' : ''} ${i === failed ? 'failed' : ''}`}
        >
          <span className="num">{i < stepIndex ? '✓' : i + 1}</span> {label}
        </div>
      ))}
    </div>
  );
}
