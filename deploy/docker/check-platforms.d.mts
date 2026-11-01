export const REQUIRED_PLATFORMS: readonly string[];
export function platformsOf(readFile: (path: string) => string): string[];
export function missingPlatforms(platforms: readonly string[]): string[];
