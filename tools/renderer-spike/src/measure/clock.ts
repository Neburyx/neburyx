export interface FrameClock {
  nextFrame(callback: (time: number) => void): void;
}

export interface Clock extends FrameClock {
  now(): number;
}
