/** A signed transaction is recoverable before it is allowed to leave the device. */
export async function persistThenBroadcast<T>(options: {
  sign: () => Promise<T>
  signature: (signed: T) => string
  persist: (signature: string) => Promise<void>
  broadcast: (signed: T) => Promise<unknown>
}): Promise<string> {
  const signed = await options.sign()
  const signature = options.signature(signed)
  await options.persist(signature)
  await options.broadcast(signed)
  return signature
}
