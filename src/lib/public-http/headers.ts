export interface HeaderReader {
  get(name: string): string | null;
}

export class ObjectHeaders implements HeaderReader {
  private readonly values = new Map<string, string>();

  constructor(headers: Record<string, string | undefined>) {
    for (const [key, value] of Object.entries(headers)) {
      if (value !== undefined) this.values.set(key.toLowerCase(), value);
    }
  }

  get(name: string): string | null {
    return this.values.get(name.toLowerCase()) ?? null;
  }
}
