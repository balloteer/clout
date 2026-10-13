import { useEffect, useState } from 'react'
import { Keyboard, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native'
import * as ImagePicker from 'expo-image-picker'
import { useWallet } from '../lib/wallet'
import { useApp } from '../lib/store'
import { postJson } from '../lib/api'
import { colors as c, fonts } from '../lib/theme'
import { Button, Icon, Txt } from '../components/ui'
import { FeedVideo, type PlaybackStatus } from '../components/feed-video'
export function Create({ onConnect }: { onConnect: () => void }) {
  const wallet = useWallet()
  const { notify } = useApp()
  const [asset, setAsset] = useState<ImagePicker.ImagePickerAsset | null>(null)
  const [caption, setCaption] = useState('')
  const [busy, setBusy] = useState(false)
  const [published, setPublished] = useState(false)
  const [height, setHeight] = useState(0)
  const [composerHeight, setComposerHeight] = useState(0)
  const [keyboardVisible, setKeyboardVisible] = useState(false)
  const [previewStatus, setPreviewStatus] = useState<PlaybackStatus>('idle')
  const compact = (height > 0 && height < 520) || keyboardVisible
  const showPreview = !keyboardVisible && (height === 0 || height >= 300)
  const previewWidth = compact ? 84 : 112
  const previewHeight = Math.min(compact ? 170 : 240, Math.max(48, composerHeight - (compact ? 26 : 34)))
  const videoAspect = asset?.width && asset.height ? asset.width / asset.height : 1200 / 2670
  const videoWidth = Math.min(previewWidth, previewHeight * videoAspect)
  useEffect(() => {
    if (Platform.OS === 'web') return
    const show = Keyboard.addListener('keyboardDidShow', () => setKeyboardVisible(true))
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardVisible(false))
    return () => {
      show.remove()
      hide.remove()
    }
  }, [])
  async function choose() {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['videos'],
        allowsEditing: false,
        quality: 1,
      })
      if (!result.canceled) {
        const selected = result.assets[0]
        if (selected.duration && selected.duration > 60_000) {
          notify('Choose a video that is 60 seconds or shorter.')
          return
        }
        setAsset(selected)
        setPreviewStatus('loading')
        setPublished(false)
      }
    } catch {
      notify('Could not open your videos. Check photo permissions and try again.')
    }
  }
  async function publish() {
    if (!wallet.address) {
      onConnect()
      return
    }
    if (!asset || !caption.trim()) return
    setBusy(true)
    try {
      const result = await postJson<{ uploadUrl: string; postId: string }>('/v1/uploads', {
        caption: caption.trim(),
        maxDurationSeconds: 60,
      })
      const form = new FormData()
      if (Platform.OS === 'web') {
        const blob = await fetch(asset.uri).then((r) => r.blob())
        form.append('file', blob, asset.fileName ?? 'clout.mp4')
      } else
        form.append('file', {
          uri: asset.uri,
          type: asset.mimeType ?? 'video/mp4',
          name: asset.fileName ?? 'clout.mp4',
        } as unknown as Blob)
      const response = await fetch(result.uploadUrl, { method: 'POST', body: form })
      if (!response.ok) throw new Error('The upload did not finish. Please try again.')
      setPublished(true)
      notify('Video uploaded. It will appear after processing.')
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Upload failed')
    } finally {
      setBusy(false)
    }
  }
  return (
    <View
      testID="create-composer"
      style={[s.content, compact && s.compact]}
      onLayout={({ nativeEvent: { layout } }) => setHeight(layout.height)}
    >
      {!keyboardVisible && (
        <View style={s.heading}>
          <Txt display style={[s.title, compact && s.compactTitle]}>
            New post
          </Txt>
          {!compact && <Txt style={s.limit}>60 sec max</Txt>}
        </View>
      )}
      <View
        testID="create-fields"
        style={[s.composer, compact && s.compactComposer]}
        onLayout={({ nativeEvent: { layout } }) => setComposerHeight(layout.height)}
      >
        <View style={s.captionColumn}>
          <View style={s.captionHeading}>
            <Txt style={s.label}>Caption</Txt>
            {!showPreview && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={asset ? 'Choose another video' : 'Choose a video'}
                disabled={busy}
                onPress={() => void choose()}
                style={s.inlineChoose}
              >
                <Icon name={asset ? 'videocam-outline' : 'add'} size={18} color={c.pink} />
                <Txt style={s.chooseText}>{asset ? 'Change' : 'Add video'}</Txt>
              </Pressable>
            )}
          </View>
          <TextInput
            testID="create-caption"
            accessibilityLabel="Post caption"
            value={caption}
            onChangeText={setCaption}
            editable={!busy}
            maxLength={280}
            placeholder="Make them stop scrolling…"
            placeholderTextColor={c.muted}
            multiline
            scrollEnabled
            textAlignVertical="top"
            style={s.caption}
          />
          <Txt style={s.count}>{caption.length}/280</Txt>
        </View>
        {showPreview && (
          <View style={{ width: previewWidth }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={asset ? 'Choose another video' : 'Choose a video'}
              accessibilityHint="Choose a video from your camera roll, up to 60 seconds."
              disabled={busy}
              onPress={() => void choose()}
              style={[s.preview, { width: previewWidth, height: previewHeight }]}
            >
              {asset && (
                <View pointerEvents="none" style={{ width: videoWidth, height: videoWidth / videoAspect }}>
                  <FeedVideo key={asset.uri} source={asset.uri} muted paused onStatus={setPreviewStatus} />
                </View>
              )}
              {(!asset || previewStatus === 'error') && (
                <View pointerEvents="none" style={s.previewEmpty}>
                  <Icon name={asset ? 'videocam-outline' : 'add'} size={30} color={c.pink} />
                  <Txt style={s.previewText}>{asset ? 'Video selected' : 'Your video'}</Txt>
                </View>
              )}
              <View pointerEvents="none" style={s.previewAction}>
                <Txt style={s.chooseText}>{asset ? 'Change' : 'Choose video'}</Txt>
              </View>
            </Pressable>
          </View>
        )}
      </View>
      <View testID="create-publish-footer" style={s.publishFooter}>
        {!compact && <Txt style={s.note}>Post first. Launch a market later.</Txt>}
        <Button
          onPress={() => void publish()}
          disabled={busy || published || (!!wallet.address && (!asset || !caption.trim()))}
          icon={published ? 'checkmark-circle' : 'arrow-up-circle-outline'}
        >
          {published
            ? 'Uploaded · processing'
            : busy
              ? 'Uploading…'
              : wallet.address
                ? 'Publish post'
                : 'Connect wallet to publish'}
        </Button>
        <Txt style={s.footer}>Only share content you own or can use.</Txt>
      </View>
    </View>
  )
}
const s = StyleSheet.create({
  content: {
    flex: 1,
    minHeight: 0,
    padding: 20,
    maxWidth: 650,
    width: '100%',
    alignSelf: 'center',
    gap: 16,
  },
  compact: { padding: 12, gap: 10 },
  heading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  title: { fontSize: 30, lineHeight: 38, flexShrink: 1 },
  compactTitle: { fontSize: 26, lineHeight: 32 },
  limit: { color: c.muted, fontSize: 12, lineHeight: 18 },
  composer: {
    flex: 1,
    minHeight: 0,
    flexDirection: 'row',
    gap: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: c.line,
    borderRadius: 18,
    backgroundColor: c.surface,
  },
  compactComposer: { padding: 12, gap: 12 },
  captionColumn: { flex: 1, minHeight: 0, minWidth: 0, gap: 8 },
  captionHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  label: { fontSize: 14, lineHeight: 20, fontWeight: '700' },
  caption: {
    flex: 1,
    minHeight: 40,
    fontFamily: fonts.body,
    fontSize: 16,
    lineHeight: 24,
    color: c.cream,
    padding: 0,
    textAlignVertical: 'top',
  },
  count: { color: c.muted, fontSize: 11, lineHeight: 16, textAlign: 'right' },
  preview: {
    backgroundColor: c.ink,
    borderWidth: 1,
    borderColor: c.line,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  previewEmpty: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 8,
    paddingBottom: 42,
  },
  previewText: { color: c.muted, fontSize: 12, lineHeight: 17, textAlign: 'center' },
  previewAction: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(21,18,28,.9)',
    paddingHorizontal: 4,
  },
  chooseText: { color: c.pink, fontSize: 12, lineHeight: 17, fontWeight: '700', textAlign: 'center' },
  inlineChoose: { minHeight: 48, minWidth: 48, flexDirection: 'row', alignItems: 'center', gap: 5 },
  publishFooter: { flexShrink: 0, gap: 8 },
  note: { color: c.muted, fontSize: 12, lineHeight: 18, textAlign: 'center' },
  footer: { fontSize: 11, lineHeight: 16, color: c.muted, textAlign: 'center' },
})
