import Ionicons from '@expo/vector-icons/Ionicons'
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
  type TextProps,
} from 'react-native'
import { colors as c, fonts } from '../lib/theme'
import type { ComponentProps, PropsWithChildren } from 'react'
export type IconName = ComponentProps<typeof Ionicons>['name']
export function Icon({
  name,
  size = 22,
  color = c.cream,
}: {
  name: IconName
  size?: number
  color?: string
}) {
  return <Ionicons name={name} size={size} color={color} />
}
export function Txt({
  children,
  style,
  display = false,
  numberOfLines,
  ...props
}: {
  children: React.ReactNode
  style?: StyleProp<TextStyle>
  display?: boolean
  numberOfLines?: number
} & TextProps) {
  return (
    <Text {...props} numberOfLines={numberOfLines} style={[styles.text, display && styles.display, style]}>
      {children}
    </Text>
  )
}
export function Button({
  children,
  onPress,
  icon,
  secondary = false,
  disabled = false,
  style,
}: {
  children: React.ReactNode
  onPress: () => void
  icon?: IconName
  secondary?: boolean
  disabled?: boolean
  style?: StyleProp<ViewStyle>
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={typeof children === 'string' ? children : undefined}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        secondary && styles.secondary,
        disabled && { opacity: 0.5 },
        pressed && { transform: [{ translateY: 2 }] },
        style,
      ]}
    >
      {icon && <Icon name={icon} color={secondary ? c.cream : c.ink} size={19} />}
      <Txt style={[styles.buttonText, { color: secondary ? c.cream : c.ink }]}>{children}</Txt>
    </Pressable>
  )
}
export function Badge({
  children,
  color = c.lime,
  style,
}: {
  children: React.ReactNode
  color?: string
  style?: StyleProp<ViewStyle>
}) {
  return (
    <View style={[styles.badge, { backgroundColor: color }, style]}>
      <Txt style={styles.badgeText}>{children}</Txt>
    </View>
  )
}
export function Avatar({
  letter,
  color = c.pink,
  size = 38,
}: {
  letter: string
  color?: string
  size?: number
}) {
  return (
    <View
      style={[styles.avatar, { width: size, height: size, borderRadius: size / 2, backgroundColor: color }]}
    >
      <Txt display style={{ fontSize: size * 0.4, color: c.ink }}>
        {letter.slice(0, 1).toUpperCase()}
      </Txt>
    </View>
  )
}
export function Empty({
  icon,
  title,
  children,
  action,
}: {
  icon: IconName
  title: string
  children: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <View style={styles.empty}>
      <View style={styles.emptyIcon}>
        <Icon name={icon} size={32} color={c.pink} />
      </View>
      <Txt display style={styles.emptyTitle}>
        {title}
      </Txt>
      <Txt style={styles.emptyCopy}>{children}</Txt>
      {action}
    </View>
  )
}
export function Section({
  title,
  children,
  aside,
}: { title: string; aside?: React.ReactNode } & PropsWithChildren) {
  return (
    <View style={{ gap: 18, marginBottom: 30 }}>
      <View style={styles.sectionHead}>
        <Txt display style={{ fontSize: 24, lineHeight: 30, flexShrink: 1, minWidth: 0 }}>
          {title}
        </Txt>
        {aside}
      </View>
      {children}
    </View>
  )
}
const styles = StyleSheet.create({
  text: { fontFamily: fonts.body, color: c.cream, fontSize: 15, lineHeight: 22 },
  display: { fontFamily: fonts.display },
  button: {
    minHeight: 50,
    maxWidth: '100%',
    borderRadius: 16,
    paddingHorizontal: 22,
    paddingVertical: 13,
    backgroundColor: c.lime,
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondary: { backgroundColor: c.surface, borderWidth: 1, borderColor: c.line },
  buttonText: { fontWeight: '700', fontSize: 15, flexShrink: 1, minWidth: 0, textAlign: 'center' },
  badge: {
    borderRadius: 8,
    paddingHorizontal: 9,
    paddingVertical: 3,
    alignSelf: 'flex-start',
    maxWidth: '100%',
  },
  badgeText: { fontSize: 11, fontWeight: '800', color: c.ink, lineHeight: 17 },
  avatar: { alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: c.ink },
  empty: { paddingVertical: 44, paddingHorizontal: 24, alignItems: 'center', gap: 16 },
  emptyIcon: {
    width: 76,
    height: 76,
    backgroundColor: c.surface,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTitle: { fontSize: 24, textAlign: 'center', lineHeight: 32 },
  emptyCopy: { textAlign: 'center', color: c.muted, maxWidth: 350 },
  sectionHead: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    alignItems: 'center',
    justifyContent: 'space-between',
  },
})
