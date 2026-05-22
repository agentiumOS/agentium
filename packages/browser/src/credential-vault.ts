/**
 * Secure credential store for BrowserAgent.
 *
 * Secrets are stored in memory and NEVER sent to the LLM.
 * The model works with placeholders (e.g. `{{email}}`, `{{password}}`),
 * and the agent resolves them to real values only at execution time.
 */
export class CredentialVault {
  private secrets = new Map<string, string>();

  constructor(initial?: Record<string, string>) {
    if (initial) {
      for (const [key, value] of Object.entries(initial)) {
        this.set(key, value);
      }
    }
  }

  /** Store a credential. Key names become the placeholder: `{{key}}`. */
  set(key: string, value: string): this {
    this.secrets.set(key.toLowerCase(), value);
    return this;
  }

  /** Retrieve a credential value. Returns undefined if not found. */
  get(key: string): string | undefined {
    return this.secrets.get(key.toLowerCase());
  }

  has(key: string): boolean {
    return this.secrets.has(key.toLowerCase());
  }

  /** List available placeholder names (never exposes values). */
  keys(): string[] {
    return [...this.secrets.keys()];
  }

  /**
   * Load credentials from environment variables.
   * Maps env var names to placeholder keys.
   *
   * @example
   * vault.fromEnv({ email: "LOGIN_EMAIL", password: "LOGIN_PASS" });
   */
  fromEnv(mapping: Record<string, string>): this {
    for (const [key, envVar] of Object.entries(mapping)) {
      const value = process.env[envVar];
      if (value) this.set(key, value);
    }
    return this;
  }

  /**
   * Replace `{{key}}` placeholders in text with actual credential values.
   * Used internally by BrowserAgent right before executing a type action.
   */
  resolve(text: string): string {
    return text.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
      return this.get(key) ?? `{{${key}}}`;
    });
  }

  /**
   * Replace any occurrence of real credential values in text with
   * their `{{key}}` placeholder. Used to sanitize logs and action history.
   */
  mask(text: string): string {
    let masked = text;
    for (const [key, value] of this.secrets) {
      if (value && masked.includes(value)) {
        masked = masked.split(value).join(`{{${key}}}`);
      }
    }
    return masked;
  }
}
