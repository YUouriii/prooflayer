/**
 * Evidence provider registry.
 *
 * Maps a provider name to a factory so the verification service can select
 * DemoEvidenceProvider or GmailEvidenceProvider (or future providers)
 * without duplicating verification logic and without the engine knowing
 * which provider produced the evidence.
 */
import type { EvidenceProvider } from './providers.js';
import { DemoEvidenceProvider } from './providers.js';

export type EvidenceProviderFactory = () => EvidenceProvider;

export const DEMO_PROVIDER_NAME = 'demo';
export const GMAIL_PROVIDER_NAME = 'gmail';

export const SUPPORTED_PROVIDER_NAMES: readonly string[] = [DEMO_PROVIDER_NAME, GMAIL_PROVIDER_NAME];

export class EvidenceProviderRegistry {
  private readonly factories = new Map<string, EvidenceProviderFactory>();

  constructor() {
    this.factories.set(DEMO_PROVIDER_NAME, () => new DemoEvidenceProvider());
  }

  register(name: string, factory: EvidenceProviderFactory): void {
    this.factories.set(name, factory);
  }

  resolve(name: string): EvidenceProvider {
    const factory = this.factories.get(name);
    if (!factory) {
      throw new Error('UNKNOWN_PROVIDER');
    }
    return factory();
  }

  names(): string[] {
    return [...this.factories.keys()];
  }
}
