export interface Gate {
  run(): string;
}
export interface GateRequest {
  readonly id: string;
}
export interface GatePage {
  readonly items: readonly string[];
}
