// Toda wallet criada pelos helpers de teste entra aqui; o preload confere a invariante de todas no fim da execução.
const created = new Set<string>();

export function registerWallet(walletId: string): void {
  created.add(walletId);
}

export function registeredWallets(): string[] {
  return [...created];
}
