// Browser build is a preview; session storage avoids retaining connection proofs across browser sessions.
export const accountLinkStorage = {
  read: async (owner: string) => globalThis.sessionStorage?.getItem(`clout-link-${owner}`) ?? null,
  write: async (owner: string, value: string) => {
    if (!globalThis.sessionStorage) throw new Error('Secure account linking is unavailable in this browser.')
    globalThis.sessionStorage.setItem(`clout-link-${owner}`, value)
  },
  remove: async (owner: string) => {
    globalThis.sessionStorage?.removeItem(`clout-link-${owner}`)
  },
}
