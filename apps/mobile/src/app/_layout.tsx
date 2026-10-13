import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useFonts } from 'expo-font'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { ActivityIndicator, View } from 'react-native'
import { WalletProvider } from '../lib/wallet'
import { AppStore } from '../lib/store'
import { colors } from '../lib/theme'
export default function Layout() {
  const [loaded, error] = useFonts({
    TitanOne: require('../../assets/brand/TitanOne-Regular.ttf'),
    DMSans: require('../../assets/brand/DMSans-Variable.ttf'),
  })
  if (!loaded && !error)
    return (
      <View style={{ flex: 1, backgroundColor: colors.ink, justifyContent: 'center' }}>
        <ActivityIndicator color={colors.pink} />
      </View>
    )
  return (
    <SafeAreaProvider>
      <WalletProvider>
        <AppStore>
          <StatusBar style="light" />
          <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.ink } }} />
        </AppStore>
      </WalletProvider>
    </SafeAreaProvider>
  )
}
