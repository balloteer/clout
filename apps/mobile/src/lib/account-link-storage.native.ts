import * as SecureStore from 'expo-secure-store'
export const accountLinkStorage = {
  read: (owner: string) => SecureStore.getItemAsync(`clout-link-${owner}`),
  write: (owner: string, value: string) => SecureStore.setItemAsync(`clout-link-${owner}`, value),
  remove: (owner: string) => SecureStore.deleteItemAsync(`clout-link-${owner}`),
}
