export class Stopped extends Error {
  constructor() {
    super('stopped by the developer');
    this.name = 'Stopped';
  }
}

export class StepFailed extends Error {
  constructor(step: string, detail = '') {
    super(`${step} failed${detail === '' ? '' : `: ${detail}`}`);
    this.name = 'StepFailed';
  }
}
