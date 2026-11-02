export interface Principal {
  readonly subject: string;
  // Provedor que o token autoriza; quando presente, precisa ser o providerId do corpo da transação.
  readonly providerId?: string;
}

export type RequestHeaders = Readonly<Record<string, string | string[] | undefined>>;

export interface Authenticator {
  // undefined = não autenticado (401).
  authenticate(headers: RequestHeaders): Promise<Principal | undefined>;
}

export const AUTHENTICATOR = Symbol('AUTHENTICATOR');

export const ANONYMOUS: Principal = { subject: 'anonymous' };

// Autenticação omitida por decisão documentada (ARCHITECTURE.md → Autenticação): todo chamador é anônimo.
export class NoopAuthenticator implements Authenticator {
  async authenticate(): Promise<Principal> {
    return ANONYMOUS;
  }
}
