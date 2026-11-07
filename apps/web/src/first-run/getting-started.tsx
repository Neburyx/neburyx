import { STEPS_COPY } from './copy.js';

export function GettingStarted() {
  return (
    <section className="getting-started" aria-label={STEPS_COPY.label}>
      <ol>
        {STEPS_COPY.steps.map((step) => (
          <li key={step.title}>
            <h3>{step.title}</h3>
            <p>{step.text}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
